#!/usr/bin/env python3
"""Probe actual runtime MI permissions; email is opt-in and never retried automatically."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import time
import uuid

SPEC = importlib.util.spec_from_file_location("auth_validation", Path(__file__).parents[1] / "auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


def execute(deployment, app_name, script):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        ["az", "containerapp", "exec", "-g", deployment.group, "-n", app_name,
         "--subscription", deployment.subscription, "--command", "node"],
        stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output, sent = b"", False
    deadline = time.monotonic() + 300
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
                if len(output) > 1024 * 1024:
                    raise auth.EvidenceError("Runtime probe output exceeded its bound")
                if not sent and b'Welcome to Node' in output:
                    # Editor mode accepts the actual source, not a quoted shell command.
                    os.write(master, b".editor\r")
                    time.sleep(1)
                    for line in script.splitlines():
                        os.write(master, line.encode() + b"\r")
                    os.write(master, b"\x04")
                    sent = True
            if process.poll() is not None:
                break
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace")).replace("\r", "")
        results = re.findall(r"^(?:> )?AUTH_RUNTIME_RBAC_RESULT:(\{[^\n]+\})$", text, re.MULTILINE)
        if len(results) != 1:
            raise auth.EvidenceError("Runtime probe has no unique completed result; do not retry an uncertain email send "
                                     f"(sourceSent={sent}, resultCount={len(results)}, "
                                     f"syntaxError={'SyntaxError' in text}, bytes={len(output)})")
        document = json.loads(results[0])
        if not isinstance(document.get("checks"), list):
            raise auth.EvidenceError("Runtime probe returned malformed evidence")
        return document
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)


def run(report, deployment, recipient):
    d = deployment
    apps = d.azure("containerapp", "list", "-g", d.group)
    selected = [app for app in apps if app.get("tags", {}).get("azd-service-name") == "app-admin"]
    if len(selected) != 1:
        raise auth.EvidenceError("Cannot discover the existing admin container for the runtime MI probe")
    app = selected[0]
    identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
    if identity["id"].lower() not in {key.lower() for key in app.get("identity", {}).get("userAssignedIdentities", {})}:
        raise auth.EvidenceError("Admin container is not attached to the expected runtime identity")
    containers = app["properties"]["template"]["containers"]
    if len(containers) != 1:
        raise auth.EvidenceError("Expected one admin container")
    image = containers[0]["image"]
    registry, _, reference = image.partition("/")
    repository, separator, tag = reference.rpartition(":")
    if not separator or "@" in reference:
        raise auth.EvidenceError("Expected an explicitly tagged deployed ACR image")
    acrs = d.azure("acr", "list", "-g", d.group)
    acr = [item for item in acrs if item.get("loginServer") == registry]
    if len(acr) != 1:
        raise auth.EvidenceError("Deployed image registry is not the selected environment's ACR")
    storage = d.azure("storage", "account", "show", "-g", d.group, "-n", d.required("STORAGE_ACCOUNT_NAME"))
    account = d.azure("account", "show")
    config = {
        "clientId": identity["clientId"], "principalId": identity["principalId"],
        "tenantId": account["tenantId"], "storageId": storage["id"], "acrId": acr[0]["id"],
        "registry": registry, "repository": repository, "tag": tag,
    }
    if recipient:
        config.update({"recipient": recipient, "communicationEndpoint": d.required("COMMUNICATION_SERVICE_ENDPOINT"),
                       "senderDomain": d.required("EMAIL_SENDER_DOMAIN")})
    fqdn = app["properties"]["configuration"]["ingress"]["fqdn"]
    status, _, _ = auth.http("GET", "https://" + fqdn)
    if status != 200:
        raise auth.EvidenceError("Existing admin site is not responsive; no runtime probe started")
    ledger = {"app": app["name"], "emailRequested": bool(recipient), "invocation": "pending", "completed": False}
    path = report.output / "runtime-rbac-ledger.json"
    path.write_text(json.dumps(ledger, indent=2) + "\n")
    script = "globalThis.authRbacConfig=" + json.dumps(config) + ";\n"
    script += Path(__file__).with_name("runtime-rbac-probe.cjs").read_text()
    document = execute(d, app["name"], script)
    ledger.update({"invocation": "returned", "completed": True})
    path.write_text(json.dumps(ledger, indent=2) + "\n")
    expected = {"storage-management-denied", "acr-management-denied", "acr-manifest-pull"}
    if recipient:
        expected.update({"email-send-authorized", "email-operation-succeeded"})
    for index, check in enumerate(document["checks"]):
        report.add("runtime-rbac:" + str(index), "runtime",
                   "PASS" if check.get("status") == "PASS" else "FAIL", check.get("name", "unknown") + ": " +
                   check.get("detail", "Missing runtime assertion detail"))
    report.check("runtime-rbac:complete", "runtime", len(document["checks"]) == len(expected) and
                 {check.get("name") for check in document["checks"]} == expected,
                 "Actual runtime MI denials, image pull and all explicitly requested email assertions completed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--send-email", action="store_true", help="Explicitly opt in to one approved test email")
    args = parser.parse_args()
    recipient = os.environ.get("AUTH_RBAC_TEST_RECIPIENT") if args.send_email else None
    if args.send_email and (not recipient or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient)):
        parser.error("--send-email requires an approved address in AUTH_RBAC_TEST_RECIPIENT")
    output = auth.ROOT / ".auth-results" / ("runtime-rbac-" + str(uuid.uuid4()))
    output.mkdir()
    report = auth.Report(output)
    report.guarded("runtime-rbac:scenario", "runtime", lambda: run(report, auth.Deployment(args.environment), recipient))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
