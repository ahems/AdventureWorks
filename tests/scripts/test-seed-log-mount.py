#!/usr/bin/env python3
"""Verify the seed log mount using two non-seeding execution overrides."""

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import time
import uuid

SPEC = importlib.util.spec_from_file_location(
    "auth_validation", Path(__file__).resolve().parents[1] / "auth" / "validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


def probe_template(template, filename, content, phase):
    if phase not in {"write", "read-cleanup", "cleanup"}:
        raise auth.EvidenceError("Unknown mount probe phase")
    if not re.fullmatch(r"auth-mount-[A-Za-z0-9-]+\.log", filename):
        raise auth.EvidenceError("Invalid probe filename")
    if not content.isalnum():
        raise auth.EvidenceError("Invalid probe content")
    result = copy.deepcopy(template)
    containers = result.get("containers", [])
    if len(containers) != 1 or not any(
            mount.get("volumeName") == "logs" and mount.get("mountPath") == "/logs"
            for mount in containers[0].get("volumeMounts", [])):
        raise auth.EvidenceError("Expected the existing single-container /logs mount")
    if not any(volume.get("name") == "logs" and volume.get("storageName") == "seed-job" and
               volume.get("storageType") == "AzureFile" for volume in result.get("volumes", [])):
        raise auth.EvidenceError("Expected the existing Azure Files seed-job volume")
    script = (
        "$ErrorActionPreference='Stop'; "
        f"$path='/logs/{filename}'; $expected='{content}'; "
        "if (-not ((Get-Content /proc/mounts) -match ' /logs cifs ')) "
        "{ throw 'Expected an SMB mount at /logs' }; "
    )
    if phase == "write":
        script += (
            "$file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write); "
            "try { $bytes=[Text.Encoding]::UTF8.GetBytes($expected); "
            "$file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }; "
        )
    else:
        if phase == "read-cleanup":
            script += "if (-not [IO.File]::Exists($path)) { throw 'Persisted probe file missing' }; "
        script += (
            "if ([IO.File]::Exists($path)) { "
            "if ([IO.File]::ReadAllText($path) -cne $expected) { throw 'Probe content mismatch' }; "
            "[IO.File]::Delete($path) }; "
            "if ([IO.File]::Exists($path)) { throw 'Probe cleanup failed' }; "
        )
    script += "Write-Output 'SEED_LOG_MOUNT_PROBE_OK'"
    containers[0]["command"] = ["pwsh"]
    containers[0]["args"] = ["-NoLogo", "-NoProfile", "-Command", script]
    containers[0]["env"] = []
    return result


def run(report, deployment, timeout):
    d = deployment
    job_name = d.required("SERVICE_SEED_JOB_NAME")
    environment_name = d.required("CONTAINER_APP_ENVIRONMENT_NAME")
    job = d.azure("containerapp", "job", "show", "-g", d.group, "-n", job_name)
    original = job["properties"]["template"]
    configuration = job["properties"]["configuration"]
    if (configuration.get("triggerType") != "Manual" or configuration.get("replicaRetryLimit") != 0 or
            configuration.get("manualTriggerConfig", {}).get("parallelism", 1) != 1 or
            configuration.get("manualTriggerConfig", {}).get("replicaCompletionCount", 1) != 1):
        raise auth.EvidenceError("Mount probe requires the manual, single-replica, no-retry seed job")
    executions = d.azure("containerapp", "job", "execution", "list", "-g", d.group, "-n", job_name)
    if any(item.get("properties", {}).get("status") not in {"Succeeded", "Failed", "Stopped"}
           for item in executions):
        raise auth.EvidenceError("A seed job execution may be active; no probe was started")
    identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
    env = d.arm("Microsoft.App/managedEnvironments/" + environment_name, "2026-03-02-preview")
    identities = env.get("identity", {}).get("userAssignedIdentities", {})
    if identity["id"].lower() not in {key.lower() for key in identities}:
        raise auth.EvidenceError("Existing runtime identity is not attached to the ACA environment")
    mount = d.arm("Microsoft.App/managedEnvironments/" + environment_name + "/storages/seed-job",
                  "2026-03-02-preview")["properties"]["azureFile"]
    if (str(mount.get("identity", "")).lower() != identity["id"].lower() or mount.get("accountKey") or
            mount.get("accountKeyVaultProperties") or mount.get("accessMode") != "ReadWrite" or
            mount.get("accountName") != d.required("STORAGE_ACCOUNT_NAME") or
            mount.get("shareName") != "seed-job-logs"):
        raise auth.EvidenceError("Seed mount is not explicitly using the existing ACA identity without a key")
    storage = d.arm("Microsoft.Storage/storageAccounts/" + d.required("STORAGE_ACCOUNT_NAME"), "2025-06-01")
    properties = storage["properties"]
    if (properties.get("azureFilesIdentityBasedAuthentication") or {}).get(
            "smbOAuthSettings", {}).get("isSmbOAuthEnabled") is not True:
        raise auth.EvidenceError("Storage SMB OAuth is not enabled")
    report.check("seed-mount:shared-key-disabled", "infra",
                 properties.get("allowSharedKeyAccess") is False, "Storage Shared Key access is disabled")
    roles = d.azure("role", "assignment", "list", "--scope", storage["id"])
    role_id = "a235d3ee-5935-4cfb-8cc5-a3303ad5995e"
    if not any(item.get("principalId", "").lower() == identity["principalId"].lower() and
               item.get("scope", "").lower() == storage["id"].lower() and
               item.get("roleDefinitionId", "").lower().endswith("/" + role_id) and
               not item.get("condition") for item in roles):
        raise auth.EvidenceError("The environment identity's explicit SMB MI Admin role was not proven")
    report.add("seed-mount:identity", "infra", "PASS",
               "Mount explicitly uses the existing ACA environment UAMI and SMB MI Admin role")
    filename, content = "auth-mount-" + uuid.uuid4().hex + ".log", uuid.uuid4().hex
    ledger = {"filename": filename, "executions": [], "cleaned": False, "jobTemplateUnchanged": False}
    path = report.output / "seed-log-mount-ledger.json"

    def save():
        path.write_text(json.dumps(ledger, indent=2) + "\n")

    def execute(phase):
        entry = {"phase": phase, "status": "issuance-pending"}
        ledger["executions"].append(entry)
        save()
        template = probe_template(original, filename, content, phase)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
            json.dump(template, handle)
            handle.flush()
            started = d.azure("containerapp", "job", "start", "-g", d.group, "-n", job_name,
                              "--yaml", handle.name)
        name = started.get("name")
        if not isinstance(name, str) or not name:
            raise auth.EvidenceError("Probe execution name missing; do not retry an uncertain start")
        entry.update({"name": name, "status": "started"})
        save()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            execution = d.azure("containerapp", "job", "execution", "show", "-g", d.group, "-n", job_name,
                                "--job-execution-name", name)
            status = execution.get("properties", {}).get("status")
            entry["status"] = status
            save()
            if status == "Succeeded":
                report.add("seed-mount:" + phase, "storage", "PASS",
                           "Exact non-seeding execution succeeded: " + name)
                return
            if status in {"Failed", "Stopped"}:
                report.add("seed-mount:" + phase, "storage", "FAIL", "Probe execution " + status + ": " + name)
                raise auth.EvidenceError("SMB probe execution did not succeed")
            time.sleep(10)
        raise auth.EvidenceError("SMB probe execution timed out; inspect the exact execution before cleanup")

    save()
    try:
        execute("write")
        execute("read-cleanup")
        ledger["cleaned"] = True
        save()
    finally:
        if not ledger["cleaned"] and ledger["executions"][-1]["status"] in {"Succeeded", "Failed", "Stopped"}:
            try:
                execute("cleanup")
                ledger["cleaned"] = True
            except auth.EvidenceError as error:
                report.add("seed-mount:cleanup-error", "cleanup", "FAIL", str(error))
        current = d.azure("containerapp", "job", "show", "-g", d.group, "-n", job_name)
        ledger["jobTemplateUnchanged"] = current["properties"]["template"] == original
        report.check("seed-mount:job-unchanged", "cleanup", ledger["jobTemplateUnchanged"],
                     "Stored job template is unchanged; only execution commands were overridden")
        report.check("seed-mount:cleanup", "cleanup", ledger["cleaned"],
                     "Only the uniquely named probe file was removed; existing seed logs were untouched")
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--timeout", type=int, default=600, help="Maximum wait per execution, in seconds")
    args = parser.parse_args()
    if not 30 <= args.timeout <= 1800:
        parser.error("--timeout must be between 30 and 1800")
    output = auth.ROOT / ".auth-results" / ("seed-log-mount-" + str(uuid.uuid4()))
    output.mkdir()
    report = auth.Report(output)
    report.guarded("seed-mount:scenario", "storage", lambda: run(report, auth.Deployment(args.environment), args.timeout))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
