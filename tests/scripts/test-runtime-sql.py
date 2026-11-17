#!/usr/bin/env python3
"""Read-only effective SQL permission evidence from the existing MCP runtime."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("auth_validation", ROOT / "tests/auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)
SPEC = importlib.util.spec_from_file_location("private_entrypoint", ROOT / "tests/auth/container/entrypoint.py")
private = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(private)


def parse_result(output):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace")).replace("\r", "")
    results = re.findall(r'(\{"checks":\[[^\n]*\]\})', text)
    endings = re.findall(r"AUTH_SQL_FINISHED:(\d+):(\d+)", text)
    if len(results) != 1:
        raise auth.EvidenceError("SQL probe did not return one structured result; output withheld")
    try:
        document = json.loads(results[0])
    except ValueError as error:
        raise auth.EvidenceError("SQL probe returned malformed evidence; output withheld") from error
    status = int(endings[0][0]) if len(endings) == 1 else None
    cleaned = len(endings) == 1 and endings[0][1] == "0"
    private.validate_sql_evidence(document, status)
    return document, cleaned


def shell_script(payload, manifest, nonce):
    directory = "/tmp/auth-assurance-probe-" + nonce
    encoded_probe = base64.encodebytes(payload).decode("ascii")
    encoded_manifest = base64.encodebytes(json.dumps(manifest).encode("utf-8")).decode("ascii")
    return f"""set -e
umask 077
d='{directory}'
mkdir "$d"
trap 'rm -f "$d/PrivateProbe.dll" "$d/manifest.json"; rmdir "$d"' EXIT
base64 -d > "$d/PrivateProbe.dll" <<'AUTH_SQL_DLL'
{encoded_probe}AUTH_SQL_DLL
base64 -d > "$d/manifest.json" <<'AUTH_SQL_MANIFEST'
{encoded_manifest}AUTH_SQL_MANIFEST
set +e
AUTH_ASSURANCE_MANIFEST_FILE="$d/manifest.json" dotnet exec --depsfile /app/AdventureWorks.deps.json --runtimeconfig /app/AdventureWorks.runtimeconfig.json "$d/PrivateProbe.dll"
status=$?
rm -f "$d/PrivateProbe.dll" "$d/manifest.json"
removed=$?
if [ "$removed" -eq 0 ]; then
    rmdir "$d"
    removed=$?
fi
if [ "$removed" -eq 0 ]; then
    trap - EXIT
fi
printf 'AUTH_SQL_FINISHED:%s:%s\\n' "$status" "$removed"
exit
"""


def execute(deployment, app_name, payload, manifest):
    nonce = uuid.uuid4().hex
    script = shell_script(payload, manifest, nonce).encode("ascii")
    master, slave = pty.openpty()
    try:
        process = subprocess.Popen(
            ["az", "containerapp", "exec", "-g", deployment.group, "-n", app_name,
             "--subscription", deployment.subscription, "--command", "sh", "--only-show-errors"],
            stdin=slave, stdout=slave, stderr=slave)
    except OSError as error:
        os.close(slave)
        os.close(master)
        raise auth.EvidenceError("Cannot start the existing-container SQL diagnostic") from error
    os.close(slave)
    os.set_blocking(master, False)
    output = bytearray()
    pending = b""
    stage = "connect"
    marker = f"AUTH_SQL_READY_{nonce}".encode()
    deadline = time.monotonic() + 420
    try:
        while time.monotonic() < deadline:
            readable, writable, _ = select.select([master], [master] if pending else [], [], 1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    raise auth.EvidenceError("SQL diagnostic output exceeded its bound; output withheld")
                if stage == "connect" and re.search(rb"(?:^|[\r\n])[^\r\n]*[#$] $", output):
                    pending = b"stty -echo; printf '\\n" + marker + b"\\n'\n"
                    stage = "ready"
                elif stage == "ready" and marker in output:
                    pending = script
                    stage = "running"
            if writable and pending:
                try:
                    sent = os.write(master, pending[:1024])
                    pending = pending[sent:]
                except BlockingIOError:
                    pass
            if process.poll() is not None:
                break
        document, cleaned = parse_result(output)
        return document, cleaned
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)


def run(report, deployment):
    app_name = deployment.required("SERVICE_API_MCP_NAME")
    app = deployment.azure("containerapp", "show", "-g", deployment.group, "-n", app_name)
    identity = deployment.azure(
        "identity", "show", "-g", deployment.group, "-n", deployment.required("USER_MANAGED_IDENTITY_NAME"))
    if not isinstance(app, dict) or not isinstance(identity, dict) or not isinstance(identity.get("id"), str):
        raise auth.EvidenceError("Selected MCP container or runtime identity metadata is incomplete")
    if identity["id"].lower() not in {
            key.lower() for key in app.get("identity", {}).get("userAssignedIdentities", {})}:
        raise auth.EvidenceError("Selected MCP container lacks the configured runtime identity")
    account = deployment.azure("account", "show")
    server = deployment.azure(
        "sql", "server", "show", "-g", deployment.group, "-n", deployment.required("SQL_SERVER_NAME"))
    if (not isinstance(account, dict) or not isinstance(server, dict) or
            not all(isinstance(value, str) and value for value in [
                identity.get("clientId"), identity.get("principalId"), account.get("tenantId"),
                server.get("fullyQualifiedDomainName")])):
        raise auth.EvidenceError("Selected identity or SQL connection metadata is incomplete")
    manifest = {
        "identity": {"clientId": identity["clientId"], "principalId": identity["principalId"],
                     "tenantId": account["tenantId"]},
        "sql": {"host": server["fullyQualifiedDomainName"], "database": deployment.required("SQL_DATABASE_NAME")},
        "sqlOnly": True,
    }
    with tempfile.TemporaryDirectory(prefix="adventureworks-sql-probe-") as build:
        auth.command(["dotnet", "build", "tests/auth/private/PrivateProbe.csproj", "--no-restore",
                      "-c", "Release", "-o", build], timeout=180)
        try:
            payload = (Path(build) / "PrivateProbe.dll").read_bytes()
        except OSError as error:
            raise auth.EvidenceError("Built SQL diagnostic assembly is unavailable") from error
        report.provenance["probeBinarySha256"] = hashlib.sha256(payload).hexdigest()
        try:
            document, cleaned = execute(deployment, app_name, payload, manifest)
        except auth.EvidenceError:
            report.add("runtime-sql:cleanup", "private", "BLOCKED",
                       "Runtime-file cleanup could not be verified after an incomplete SQL diagnostic.")
            raise
    for item in document["checks"]:
        report.add("runtime-sql:" + item["id"], item["group"], item["status"], item["detail"])
    report.add("runtime-sql:cleanup", "private", "PASS" if cleaned else "BLOCKED",
               "Exact temporary runtime files were removed." if cleaned else
               "Temporary runtime-file cleanup could not be verified; no cleanup success is claimed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--output", type=Path, help="New evidence directory")
    args = parser.parse_args()
    output = (args.output or ROOT / ".auth-results" / ("runtime-sql-" + str(uuid.uuid4()))).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = auth.Report(output)
    report.add("scope:runtime-sql", "scope", "PASS",
               "Read-only SQL checks from the existing MCP container's shared runtime identity; "
               "not evidence for other principals or complete effective access.")
    def scenario():
        deployment = auth.Deployment(args.environment)
        report.provenance["azdEnvironment"] = deployment.values.get("AZURE_ENV_NAME")
        report.provenance["identityOrigin"] = "Existing MCP container, configured shared runtime UAMI"
        run(report, deployment)
    report.guarded("runtime-sql:scenario", "private", scenario)
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
