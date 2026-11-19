#!/usr/bin/env python3
"""Correlate a retained seed log with the selected managed identity and SQL target."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("auth_validation", ROOT / "tests/auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)
RUNTIME_SPEC = importlib.util.spec_from_file_location("runtime_rbac", ROOT / "tests/scripts/test-runtime-rbac.py")
runtime = importlib.util.module_from_spec(RUNTIME_SPEC)
RUNTIME_SPEC.loader.exec_module(runtime)

SEED_SETTINGS = {"AZURE_CLIENT_ID", "USER_MANAGED_IDENTITY_NAME", "SQL_SERVER_NAME", "SQL_DATABASE_NAME"}


def utc_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)", value):
        raise auth.EvidenceError("Seed execution timestamp is not an explicit UTC timestamp")
    try:
        normalized = re.sub(r"(\.\d{6})\d+(?=Z|\+)", r"\1", value).replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except ValueError as error:
        raise auth.EvidenceError("Seed execution timestamp is invalid") from error


def seed_snapshot(deployment, seed):
    d = deployment
    job_name = d.required("SERVICE_SEED_JOB_NAME")
    job = d.azure(
        "containerapp", "job", "show", "-g", d.group, "-n", job_name, "--query",
        "{identity:identity,containers:properties.template.containers[]."
        "{image:image,volumeMounts:volumeMounts},volumes:properties.template.volumes}",
    )
    executions = d.azure(
        "containerapp", "job", "execution", "list", "-g", d.group, "-n", job_name, "--query",
        "[].{id:id,name:name,status:properties.status,start:properties.startTime,end:properties.endTime,"
        "containers:properties.template.containers[].{image:image,env:env[?name=='AZURE_CLIENT_ID' || "
        "name=='USER_MANAGED_IDENTITY_NAME' || name=='SQL_SERVER_NAME' || name=='SQL_DATABASE_NAME']."
        "{name:name,value:value}}}",
    )
    try:
        containers, volumes = job["containers"], job["volumes"]
        attached = {key.lower() for key in job["identity"]["userAssignedIdentities"]}
        if len(containers) != 1 or attached != {seed["id"].lower()} or not isinstance(executions, list):
            raise ValueError("Unexpected seed job")
        mounts = [mount for mount in containers[0]["volumeMounts"] if mount.get("mountPath") == "/logs"]
        if len(mounts) != 1:
            raise ValueError("Unexpected seed log mount")
        matched_volumes = [volume for volume in volumes if volume.get("name") == mounts[0]["volumeName"]]
        if len(matched_volumes) != 1 or matched_volumes[0].get("storageType") != "AzureFile":
            raise ValueError("Unexpected seed log volume")
        mount_name = matched_volumes[0]["storageName"]
        if not isinstance(mount_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,89}", mount_name):
            raise ValueError("Invalid seed storage reference")

        candidates = []
        for execution in executions:
            items = execution["containers"]
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0]["env"], list):
                raise ValueError("Incomplete seed execution")
            env = items[0]["env"]
            names = [entry["name"] for entry in env]
            if not names:
                continue
            if len(names) != len(set(names)) or set(names) != SEED_SETTINGS:
                raise ValueError("Incomplete or duplicate seed settings")
            candidates.append((execution, {entry["name"]: entry.get("value") for entry in env}))
        if len(candidates) != 1:
            raise ValueError("Seed execution is not unique")
        execution, settings = candidates[0]
        if (execution["status"] != "Succeeded" or
                settings != {
                    "AZURE_CLIENT_ID": seed["clientId"],
                    "USER_MANAGED_IDENTITY_NAME": d.required("SEED_MANAGED_IDENTITY_NAME"),
                    "SQL_SERVER_NAME": d.required("SQL_SERVER_NAME"),
                    "SQL_DATABASE_NAME": d.required("SQL_DATABASE_NAME"),
                } or execution["containers"][0]["image"] != containers[0]["image"]):
            raise ValueError("Seed execution binding differs")
        start, end = utc_timestamp(execution["start"]), utc_timestamp(execution["end"])
        if end < start or end - start > timedelta(days=1) or end > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("Seed execution timing is invalid")
        if (not isinstance(execution.get("id"), str) or not execution["id"] or
                not isinstance(execution.get("name"), str) or
                not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,255}", execution["name"])):
            raise ValueError("Seed execution identifier is unavailable")
        return {
            "id": execution["id"], "name": execution["name"], "start": execution["start"],
            "end": execution["end"], "image": containers[0]["image"], "settings": settings,
            "attached": sorted(attached), "mount": mount_name,
        }
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("A unique successful seed execution and its current job binding were not established") from error


def admin_snapshot(deployment, identity):
    d = deployment
    name = d.required("SERVICE_APP_ADMIN_NAME")
    app = d.azure(
        "containerapp", "show", "-g", d.group, "-n", name, "--query",
        "{id:id,name:name,identity:identity,revision:properties.latestRevisionName,"
        "ready:properties.latestReadyRevisionName,state:properties.provisioningState,"
        "containers:properties.template.containers[].{name:name,image:image}}",
    )
    try:
        revision = app["revision"]
        if (app["name"] != name or app["state"] != "Succeeded" or app["ready"] != revision or
                not isinstance(revision, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", revision) or
                not isinstance(app["containers"], list) or len(app["containers"]) != 1 or
                identity["id"].lower() not in {
                    key.lower() for key in app["identity"]["userAssignedIdentities"]
                }):
            raise ValueError("Admin identity or revision differs")
        return {"id": app["id"], "name": name, "revision": revision, "containers": app["containers"],
                "attached": sorted(key.lower() for key in app["identity"]["userAssignedIdentities"])}
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("The selected ready admin container and runtime identity were not established") from error


def file_target(deployment, identity, mount_name):
    d = deployment
    account_name = d.required("STORAGE_ACCOUNT_NAME")
    environment = d.required("CONTAINER_APP_ENVIRONMENT_NAME")
    mount = d.arm("Microsoft.App/managedEnvironments/" + environment + "/storages/" + mount_name,
                  "2026-03-02-preview")
    account = d.azure("storage", "account", "show", "-g", d.group, "-n", account_name,
                      "--query", "{file:primaryEndpoints.file,sharedKey:allowSharedKeyAccess}")
    cloud = auth.json_command(["az", "cloud", "show", "--query",
                               "{name:name,suffix:suffixes.storageEndpoint}", "-o", "json"])
    try:
        properties = mount["properties"]["azureFile"]
        share = properties["shareName"]
        suffix = cloud["suffix"].lstrip(".").lower()
        trusted_suffixes = {
            "AzureCloud": "core.windows.net",
            "AzureUSGovernment": "core.usgovcloudapi.net",
            "AzureChinaCloud": "core.chinacloudapi.cn",
        }
        endpoint = account["file"]
        parsed = urlsplit(endpoint)
        if (not re.fullmatch(r"[a-z0-9]{3,24}", account_name) or
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])", share) or
                "--" in share or trusted_suffixes.get(cloud["name"]) != suffix or
                parsed.scheme != "https" or parsed.path != "/" or parsed.query or parsed.fragment or
                parsed.username or parsed.password or parsed.port not in (None, 443) or
                parsed.hostname != account_name + ".file." + suffix or
                properties.get("accountName") != account_name or
                str(properties.get("identity", "")).lower() != identity["id"].lower() or
                properties.get("accountKey") or properties.get("accountKeyVaultProperties") or
                account.get("sharedKey") is not False):
            raise ValueError("Storage target or mount identity differs")
        return {"endpoint": endpoint, "account": account_name, "suffix": suffix, "share": share}
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("The selected identity-backed Azure Files mount and endpoint were not established") from error


def run(report, deployment):
    d = deployment
    if d.runtime:
        raise auth.EvidenceError("Seed log correlation requires the local deployment identity")
    account = auth.json_command(["az", "account", "show", "--query", "{id:id,tenantId:tenantId}", "-o", "json"])
    try:
        if str(uuid.UUID(account["id"])) != str(uuid.UUID(d.subscription)):
            raise ValueError("Active subscription differs")
        tenant = str(uuid.UUID(account["tenantId"]))
        identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        seed = d.azure("identity", "show", "-g", d.group, "-n", d.required("SEED_MANAGED_IDENTITY_NAME"))
        client = str(uuid.UUID(identity["clientId"]))
        principal = str(uuid.UUID(identity["principalId"]))
        str(uuid.UUID(seed["clientId"]))
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("The active subscription or selected identity metadata is invalid") from error

    before_seed = seed_snapshot(d, seed)
    before_admin = admin_snapshot(d, identity)
    before_files = file_target(d, identity, before_seed["mount"])
    version = hashlib.sha256((ROOT / "seed-job/seed-database.ps1").read_bytes()).hexdigest()[:8].upper()
    config = {
        **before_files, "clientId": client, "principalId": principal, "tenantId": tenant,
        "start": before_seed["start"], "end": before_seed["end"], "seedClient": seed["clientId"],
        "seedName": d.required("SEED_MANAGED_IDENTITY_NAME"), "sqlServer": d.required("SQL_SERVER_NAME"),
        "sqlDatabase": d.required("SQL_DATABASE_NAME"), "scriptVersion": version,
    }
    script = "globalThis.seedSqlConfig=" + json.dumps(config, separators=(",", ":")) + ";\n"
    script += Path(__file__).with_name("seed-sql-identity-probe.cjs").read_text()
    result = runtime.execute(d, before_admin["name"], script, marker="AUTH_SEED_SQL_RESULT",
                             revision=before_admin["revision"])
    if (seed_snapshot(d, seed) != before_seed or admin_snapshot(d, identity) != before_admin or
            file_target(d, identity, before_seed["mount"]) != before_files or
            d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME")) != identity or
            d.azure("identity", "show", "-g", d.group, "-n", d.required("SEED_MANAGED_IDENTITY_NAME")) != seed):
        raise auth.EvidenceError("The seed execution, job, identities, admin revision or file target changed during the probe")
    checks = result["checks"]
    if (len(checks) != 1 or checks[0]["name"] != "seed-sql-log" or
            checks[0]["status"] not in {"PASS", "BLOCKED"} or
            checks[0].get("phase") not in {"configuration", "identity", "list", "read"} or
            (checks[0]["status"] == "PASS" and checks[0]["phase"] != "read")):
        raise auth.EvidenceError("The seed log probe returned incomplete or unexpected evidence")
    report.provenance["azdEnvironment"] = d.environment
    report.inventory["seedSqlLog"] = {"execution": before_seed["name"], "scriptVersion": version}
    detail = (
        "One retained log matches the unique successful execution's settings, the current job's selected seed "
        "identity, SQL target and eight-character script hash; it reports managed-identity login, SQL token "
        "acquisition and a successful SQL connection. SQL token claims, SQL session principal, historical job "
        "identity/mount and image digests were not independently inspected. Raw log contents were withheld."
        if checks[0]["status"] == "PASS" else
        "A unique correlated seed connection log could not be established during the " +
        checks[0]["phase"] + " phase; raw log contents were withheld."
    )
    report.add("runtime:seed-sql-log", "runtime", checks[0]["status"], detail)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", help="Selected azd environment (defaults to the current environment)")
    args = parser.parse_args()
    output = auth.ROOT / ".auth-results" / ("seed-sql-identity-" + str(uuid.uuid4()))
    output.mkdir(parents=True)
    report = auth.Report(output)
    report.guarded("runtime:seed-sql-log", "runtime", lambda: run(report, auth.Deployment(args.environment)))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
