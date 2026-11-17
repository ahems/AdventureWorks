#!/usr/bin/env python3
"""Manually run standalone private authentication tests after azd deployment."""

import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/auth"))
import runtime_config
from ephemeral_storage import new_table_name

SPEC = importlib.util.spec_from_file_location("auth_assurance", ROOT / "tests/auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)

CONTEXT_ROOTS = {
    "api", "api-functions", "api-functions.Tests", "api-mcp", "manufacturing-agent",
    "app", "app-admin", "app-manufacturing", "mcp-inspector", "tests", "scripts", "seed-job",
    "infra", "docs", "workflows", ".github",
}
CONTEXT_FILES = {"global.json", "NuGet.Config", "nuget.config", "Directory.Build.props",
                 "Directory.Build.targets", "Directory.Packages.props", "README.md", "azure.yaml"}


class RunnerError(Exception):
    pass


def command(arguments, timeout=180):
    try:
        result = subprocess.run(arguments, cwd=ROOT, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RunnerError(arguments[0] + " unavailable or timed out; inspect the run ledger before retrying") from error
    if result.returncode:
        raise RunnerError("Command failed: " + " ".join(arguments[:2]) + "; raw output withheld")
    try:
        return json.loads(result.stdout) if result.stdout.strip() else None
    except ValueError as error:
        raise RunnerError("Invalid command JSON; raw output withheld") from error


def context_files():
    packaged = ROOT / ".assurance-source-files.json"
    if not (ROOT / ".git").exists() and packaged.is_file():
        names = json.loads(packaged.read_text())
    else:
        result = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"],
                                cwd=ROOT, capture_output=True, check=True)
        names = result.stdout.decode().split("\0")
    paths = []
    for name in sorted(set(names) - {""}):
        path = Path(name)
        if path.is_absolute() or ".." in path.parts:
            raise RunnerError("Invalid source snapshot path")
        if path.parts[0] not in CONTEXT_ROOTS and name not in CONTEXT_FILES:
            continue
        if any(part in {"node_modules", "bin", "obj", "__pycache__", ".azure", ".auth-results"}
               or part == ".env" or part.startswith(".env.") for part in path.parts):
            continue
        if not (ROOT / path).is_file() or (ROOT / path).is_symlink():
            continue
        if path.parts[0] == "seed-job" and len(path.parts) > 1 and path.parts[1] not in {
                "tests", "sql", "RuntimeDatabaseAccess.psm1", "seed-database.ps1", "README.md", "dockerfile"}:
            continue
        paths.append(path)
    if not paths or Path("tests/auth/container/Dockerfile") not in paths:
        raise RunnerError("Suite build context is incomplete")
    return paths


def snapshot(paths, output):
    fingerprint = hashlib.sha256()
    output.mkdir()
    for path in paths:
        data = (ROOT / path).read_bytes()
        fingerprint.update(str(path).encode() + b"\0" + hashlib.sha256(data).digest())
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (output / ".assurance-source-files.json").write_text(json.dumps([str(path) for path in paths]))
    return fingerprint.hexdigest()


def check_job(job, ledger):
    expected = ledger["jobId"].lower()
    if (job.get("id", "").lower() != expected or
            job.get("tags", {}).get("auth-assurance-run") != ledger["runId"] or
            job.get("tags", {}).get("purpose") != "auth-assurance" or
            job.get("properties", {}).get("environmentId", "").lower() != ledger["environmentId"].lower()):
        raise RunnerError("Job identity/tags/environment differ from the ledger; refusing deletion")


def cleanup(az, ledger, save):
    # Listing distinguishes an already-removed job from a failed GET/authorization request.
    jobs = az("containerapp", "job", "list", "-g", ledger["resourceGroup"])
    matches = [job for job in jobs if job.get("id", "").lower() == ledger["jobId"].lower()]
    if len(matches) > 1:
        raise RunnerError("Nonunique cleanup target")
    if matches:
        check_job(matches[0], ledger)
        az("containerapp", "job", "delete", "-g", ledger["resourceGroup"], "-n", ledger["jobName"], "--yes")
    for attempt in range(13):
        remaining = az("containerapp", "job", "list", "-g", ledger["resourceGroup"])
        if not any(job.get("id", "").lower() == ledger["jobId"].lower() for job in remaining):
            ledger["computeCleanup"] = "verified"
            save()
            return
        if attempt < 12:
            time.sleep(5)
    raise RunnerError("Temporary job deletion was not verified within 60 seconds")


def discover(deployment):
    d = deployment
    account = d.azure("account", "show")
    if account["id"].lower() != d.subscription.lower():
        raise RunnerError("Selected Azure account does not match the azd subscription")
    environment = d.azure("containerapp", "env", "show", "-g", d.group,
                          "-n", d.required("CONTAINER_APP_ENVIRONMENT_NAME"))
    if (environment["properties"].get("provisioningState") != "Succeeded" or
            not environment["properties"].get("vnetConfiguration", {}).get("infrastructureSubnetId")):
        raise RunnerError("An existing successfully provisioned VNet-integrated ACA environment is required")
    identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
    if identity["id"].lower() not in {key.lower() for key in
                                    environment.get("identity", {}).get("userAssignedIdentities", {})}:
        raise RunnerError("The existing ACA environment does not use the selected runtime UAMI")
    registries = d.azure("acr", "list", "-g", d.group)
    endpoint = d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT")
    selected = [item for item in registries if item["loginServer"] == endpoint]
    if len(selected) != 1:
        raise RunnerError("Cannot discover the selected environment's unique registry")
    storage = d.azure("storage", "account", "show", "-g", d.group, "-n", d.required("STORAGE_ACCOUNT_NAME"))
    if storage.get("allowBlobPublicAccess") is not False or storage.get("allowSharedKeyAccess") is not False:
        raise RunnerError("Expected private blobs and disabled Storage Shared Key")
    sql = d.azure("sql", "server", "show", "-g", d.group, "-n", d.required("SQL_SERVER_NAME"))
    site = d.azure("staticwebapp", "show", "--name", d.required("SERVICE_APP_NAME"), "--resource-group", d.group)
    return account, environment, identity, selected[0], storage, sql, site


def log_lines(subscription, ledger, replica):
    arguments = ["az", "containerapp", "job", "logs", "show", "--subscription", subscription,
                 "-g", ledger["resourceGroup"], "-n", ledger["jobName"], "--execution", ledger["execution"],
                 "--replica", replica, "--container", "assurance", "--tail", "300", "--format", "text",
                 "--only-show-errors"]
    result = subprocess.run(arguments, cwd=ROOT, capture_output=True, text=True, timeout=90, check=False)
    if result.returncode:
        raise RunnerError("Job log retrieval failed; raw output withheld")
    # The installed CLI unescapes embedded quotes, corrupting --format json envelopes.
    # Text retains the application's JSON marker; wait_result validates its exact run and artifacts.
    return [{"Log": line} for line in result.stdout.splitlines() if line.strip()]


def recover_reports(deployment, ledger, output):
    d = deployment
    apps = d.azure("containerapp", "list", "-g", d.group)
    selected = [app for app in apps if app.get("tags", {}).get("azd-service-name") == "app-admin"]
    if len(selected) != 1:
        raise RunnerError("Cannot discover the existing admin container for read-only report recovery")
    app = selected[0]
    identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
    if identity["id"].lower() not in {key.lower() for key in app.get("identity", {}).get("userAssignedIdentities", {})}:
        raise RunnerError("Report reader does not use the selected runtime identity")
    storage = d.azure("storage", "account", "show", "-g", d.group, "-n", d.required("STORAGE_ACCOUNT_NAME"))
    account = d.azure("account", "show")
    if (not re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", ledger["runId"]) or
            ledger.get("reportPrefix") != "auth-assurance/" + ledger["runId"] + "/"):
        raise RunnerError("Report prefix does not match the exact run")
    configuration = {
        "runId": ledger["runId"], "prefix": ledger["reportPrefix"],
        "clientId": identity["clientId"], "principalId": identity["principalId"],
        "tenantId": account["tenantId"], "endpoint": storage["primaryEndpoints"]["blob"],
    }
    spec = importlib.util.spec_from_file_location("runtime_report_reader", ROOT / "tests/scripts/test-runtime-rbac.py")
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    source = "globalThis.authReportConfig=" + json.dumps(configuration) + ";\n"
    source += (ROOT / "tests/auth/read-reports.cjs").read_text()
    try:
        document = runtime.execute(d, app["name"], source, marker="AUTH_ASSURANCE_DOWNLOAD_RESULT",
                                   max_output=2 * 1024 * 1024)
    except runtime.auth.EvidenceError as error:
        raise RunnerError(str(error)) from error
    return verify_recovered_reports(document, ledger, output)


def verify_recovered_reports(document, ledger, output):
    checks = document.get("checks", [])
    if (not isinstance(checks, list) or len(checks) != 2 or any(not isinstance(item, dict) for item in checks) or
            {item.get("name") for item in checks} != {"runtime-identity", "report-readback"} or
            any(item.get("status") != "PASS" for item in checks) or
            document.get("runId") != ledger["runId"] or document.get("prefix") != ledger["reportPrefix"]):
        raise RunnerError("Runtime report recovery did not return complete, run-bound evidence")
    artifacts = document.get("artifacts")
    names = {"report.pdf", "report.html", "report.json", "junit.xml"}
    if not isinstance(artifacts, dict) or set(artifacts) != names:
        raise RunnerError("Runtime report recovery omitted required artifacts")
    received = {}
    manifest = {}
    total = 0
    for name in sorted(names):
        entry = artifacts[name]
        if not isinstance(entry, dict):
            raise RunnerError("Invalid recovered artifact metadata")
        size = entry.get("bytes")
        encoded = entry.get("content")
        if (type(size) is not int or size <= 0 or not isinstance(encoded, str) or
                len(encoded) != 4 * ((size + 2) // 3)):
            raise RunnerError("Invalid recovered artifact size or encoding")
        total += size
        if total > 1024 * 1024:
            raise RunnerError("Recovered reports exceed the reviewed transfer bound")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (KeyError, ValueError, TypeError) as error:
            raise RunnerError("Invalid recovered artifact encoding") from error
        if (type(entry.get("bytes")) is not int or len(data) != entry["bytes"] or not data or
                hashlib.sha256(data).hexdigest() != entry.get("sha256")):
            raise RunnerError("Recovered report checksum or length mismatch")
        received[name] = data
        manifest[name] = {"bytes": len(data), "sha256": entry["sha256"]}
    if not received["report.pdf"].startswith(b"%PDF-"):
        raise RunnerError("Recovered report.pdf is not an actual PDF")
    try:
        report = json.loads(received["report.json"])
    except ValueError as error:
        raise RunnerError("Recovered report JSON is invalid") from error
    if not isinstance(report, dict) or not isinstance(report.get("provenance"), dict):
        raise RunnerError("Recovered report has no structured provenance")
    provenance = report["provenance"]
    if (provenance.get("runId") != ledger["runId"] or provenance.get("reportPrefix") != ledger["reportPrefix"] or
            provenance.get("imageDigest") != ledger.get("imageDigest")):
        raise RunnerError("Recovered report provenance does not match the job image and run")
    counts = report.get("counts")
    if (not isinstance(counts, dict) or not counts or
            any(status not in auth.STATUSES or type(count) is not int or count < 0 for status, count in counts.items())):
        raise RunnerError("Recovered report has invalid assertion counts")
    outcome = "FAIL" if counts.get("FAIL") else "BLOCKED" if counts.get("BLOCKED") else "PASS"
    if report.get("outcome") != outcome or not sum(counts.values()):
        raise RunnerError("Recovered outcome contradicts assertion counts")
    assertions = report.get("checks")
    if (not isinstance(assertions, list) or not assertions or
            any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or
                not item["id"] or item.get("status") not in auth.STATUSES for item in assertions) or
            len({item["id"] for item in assertions}) != len(assertions) or
            Counter(item["status"] for item in assertions) != Counter(counts)):
        raise RunnerError("Recovered assertion details contradict their counts")
    output.mkdir(mode=0o700, exist_ok=False)
    for name, data in received.items():
        target = output / name
        target.touch(mode=0o600)
        target.write_bytes(data)
    (output / "artifacts.json").touch(mode=0o600)
    (output / "artifacts.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return {"runId": ledger["runId"], "prefix": ledger["reportPrefix"], "uploaded": True,
            "outcome": outcome, "counts": counts, "artifacts": manifest}


def wait_result(az, ledger, timeout, read_logs):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        execution = az("containerapp", "job", "execution", "show", "-g", ledger["resourceGroup"],
                       "-n", ledger["jobName"], "--job-execution-name", ledger["execution"])
        if execution["properties"]["status"] in {"Succeeded", "Failed", "Stopped"}:
            break
        time.sleep(10)
    else:
        raise RunnerError("Job wait timed out; execution must be reconciled, not restarted")
    replicas = az("containerapp", "job", "replica", "list", "-g", ledger["resourceGroup"],
                  "-n", ledger["jobName"], "--execution", ledger["execution"])
    if len(replicas) != 1:
        raise RunnerError("Expected exactly one job replica")
    # Only the structured, sanitized final marker is accepted; never echo raw logs.
    for attempt in range(6):
        logs = read_logs(replicas[0]["name"])
        lines = logs if isinstance(logs, list) else [logs]
        results = []
        for line in lines:
            value = line.get("Log", "") if isinstance(line, dict) else str(line)
            match = re.search(r"AUTH_ASSURANCE_RESULT:(\{.*\})", value)
            if match:
                results.append(json.loads(match[1]))
        if len(results) == 1:
            result = results[0]
            if (result.get("runId") != ledger["runId"] or result.get("uploaded") is not True or
                    result.get("prefix") != ledger["reportPrefix"] or
                    result.get("outcome") not in {"PASS", "FAIL", "BLOCKED"} or
                    not isinstance(result.get("counts"), dict) or
                    not isinstance(result.get("artifacts"), dict)):
                raise RunnerError("Malformed/mismatched final report marker")
            counts = result["counts"]
            if (not counts or any(status not in auth.STATUSES or type(count) is not int or count < 0
                                  for status, count in counts.items()) or not sum(counts.values())):
                raise RunnerError("Invalid final assertion counts")
            outcome = "FAIL" if counts.get("FAIL") else "BLOCKED" if counts.get("BLOCKED") else "PASS"
            if result["outcome"] != outcome:
                raise RunnerError("Final outcome contradicts assertion counts")
            for name in ["report.pdf", "report.html", "report.json", "junit.xml"]:
                artifact = result["artifacts"].get(name, {})
                if (type(artifact.get("bytes")) is not int or artifact["bytes"] <= 0 or
                        not re.fullmatch(r"[0-9a-f]{64}", artifact.get("sha256", ""))):
                    raise RunnerError("Required report artifact was not verified: " + name)
            return result
        if len(results) > 1:
            raise RunnerError("Ambiguous final report marker")
        time.sleep(5)
    raise RunnerError("No complete report-upload marker; preserve the local failure ledger")


def encode_configuration(configuration):
    encoded = base64.b64encode(zlib.compress(json.dumps(configuration).encode())).decode()
    if len(encoded) > 16000:
        raise RunnerError("Configuration exceeds the reviewed secure job-secret size bound")
    return encoded


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true", help="Read-only discovery; no image, job or fixture creation")
    mode.add_argument("--address-only", action="store_true",
                      help="Opt-in API-created private address fixtures, owner denials and verified cleanup only")
    mode.add_argument("--browser-only", action="store_true",
                      help="Chromium authentication scenarios for all sites, including isolated cart mutations and cleanup")
    mode.add_argument("--sql-only", action="store_true",
                      help="Read-only private SQL effective permission/identity checks; no fixtures or application calls")
    mode.add_argument("--mutations", action="store_true",
                      help="Disposable demo API writes with run-owned accounts, persisted-state assertions and residual inventory")
    parser.add_argument("--include-orders", action="store_true")
    mode.add_argument("--cleanup", type=Path, help="Recover exact job deletion using an existing local ledger")
    mode.add_argument("--recover-reports", type=Path, help="Read existing private reports using the existing runtime identity")
    args = parser.parse_args(argv)
    if args.include_orders:
        parser.error("Order mode is BLOCKED until server budgets, isolation, expiry and no-email lineage are deployed")
    for tool in ["az", "azd", "git"]:
        if not shutil.which(tool):
            raise RunnerError("Missing prerequisite: " + tool)
    d = auth.Deployment(args.environment)
    az = d.azure
    if args.cleanup or args.recover_reports:
        path = (args.cleanup or args.recover_reports).resolve()
        ledger = json.loads(path.read_text())
        expected_prefix = f"/subscriptions/{d.subscription}/resourceGroups/{d.group}/providers/Microsoft.App/jobs/"
        if (ledger.get("subscription", "").lower() != d.subscription.lower() or
                ledger.get("resourceGroup", "").lower() != d.group.lower() or
                ledger.get("jobId", "").lower() != (expected_prefix + ledger["jobName"]).lower()):
            raise RunnerError("Cleanup ledger does not match the selected environment")
        if args.cleanup:
            cleanup(az, ledger, lambda: path.write_text(json.dumps(ledger, indent=2) + "\n"))
            print("Exact temporary-job cleanup verified.")
            return 0
        output = path.parent / ("recovered-" + str(uuid.uuid4()))
        summary = recover_reports(d, ledger, output)
        jobs = az("containerapp", "job", "list", "-g", ledger["resourceGroup"])
        absent = not any(job.get("id", "").lower() == ledger["jobId"].lower() for job in jobs)
        ledger.update({"uploaded": True, "result": summary, "localReportsDirectory": str(output),
                       "reconciliation": "Reports checksum-verified through existing runtime UAMI; no infrastructure changes"})
        if absent:
            ledger["computeCleanup"] = "verified"
        path.write_text(json.dumps(ledger, indent=2) + "\n")
        print("Checksum-verified private reports: " + str(output))
        print("Exact temporary job absent: " + str(absent))
        print("Outcome: " + summary["outcome"] + "; counts: " + json.dumps(summary["counts"]))
        return 1 if summary["outcome"] == "FAIL" else 2 if summary["outcome"] == "BLOCKED" else 0
    account, environment, identity, registry, storage, sql, site = discover(d)
    if args.preflight:
        print("Read-only preflight passed: selected environment, VNet, registry, UAMI, Storage and SQL discovered.")
        print("Private data access and report-container existence still require actual in-network verification.")
        return 0
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(uuid.uuid4())
    runs_mutations = args.mutations or args.address_only or not (args.sql_only or args.browser_only)
    temporary_table_name = new_table_name() if runs_mutations else None
    output = ROOT / ".auth-results" / ("job-" + run_id)
    output.mkdir(parents=True, mode=0o700)
    ledger = {
        "schemaVersion": 1, "runId": run_id, "subscription": d.subscription, "resourceGroup": d.group,
        "jobName": "auth-test-" + run_id[-36:].replace("-", "")[:22], "environmentId": environment["id"],
        "reportPrefix": "auth-assurance/" + run_id + "/", "computeCleanup": "not-created",
        "uploaded": False, "stage": "local-infrastructure-inspection",
        "profile": "mutations" if args.mutations else "sql" if args.sql_only else "browsers" if args.browser_only else "addresses" if args.address_only else "all",
    }
    if temporary_table_name:
        ledger["temporaryTableName"] = temporary_table_name
    ledger["jobId"] = f"/subscriptions/{d.subscription}/resourceGroups/{d.group}/providers/Microsoft.App/jobs/{ledger['jobName']}"
    path = output / "lifecycle.json"
    path.touch(mode=0o600)
    save = lambda: path.write_text(json.dumps(ledger, indent=2) + "\n")
    save()
    provision_attempted = False
    try:
        local = auth.Report(output / "local")
        local.output.mkdir()
        if args.mutations:
            local.add("scope:mutations", "scope", "PASS",
                      "Disposable demo API mutation profile; self-arranged fixtures, no pristine seed prerequisite. "
                      "Uses a temporary randomized table in the existing storage account; no IaC changes. "
                      "Intentional residuals; no email, orders, simulator or paid AI.")
        elif args.sql_only:
            local.add("scope:sql-only", "scope", "PASS",
                      "Read-only effective SQL permission checks for shared runtime UAMI; not all principals or full assurance.")
        elif args.browser_only:
            local.add("scope:browser-only", "scope", "PASS",
                      "Targeted Chromium scenarios, not full authentication assurance. "
                      "No .NET/API suites, SQL fixtures, orders, AI or email; isolated cart mutations require cleanup.")
        elif args.address_only:
            local.add("scope:address-only", "scope", "PASS",
                      "Targeted address fixture lifecycle, not full authentication assurance. No orders or email.")
        else:
            auth.export_inventory(local, offline=False)
            auth.contracts(local)
            auth.infra(local, d)
        local.save()
        if not (args.sql_only or args.mutations):
            ledger["stage"] = "consumer-fixtures"
            save()
            auth.consumer_fixtures(auth.Report(output), d)
            if any(d.values.get("AUTH_TEST_CONSUMER_" + label + "_STATE") != "ready" for label in ["A", "B"]):
                raise RunnerError("Reusable local consumer fixtures must be ready before starting the private job")
        with tempfile.TemporaryDirectory(prefix="auth-suite-") as temporary:
            directory = Path(temporary)
            context = directory / "context"
            source_hash = snapshot(context_files(), context)
            tag = "suite-" + source_hash[:24]
            ledger["stage"] = "image-build"
            save()
            # Use only the explicit curated snapshot, not az acr build's implicit cwd upload.
            command(["az", "acr", "build", "--subscription", d.subscription, "--registry", registry["name"],
                     "--image", "auth-assurance:" + tag, "--file", str(context / "tests/auth/container/Dockerfile"),
                     str(context), "--no-logs", "--only-show-errors", "--output", "json"], timeout=1800)
            image = az("acr", "repository", "show", "-n", registry["name"], "--image", "auth-assurance:" + tag)
            digest = image["digest"]
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                raise RunnerError("ACR did not return an immutable image digest")
            storage_configuration = {
                "endpoint": storage["primaryEndpoints"]["blob"],
                "prefix": ledger["reportPrefix"],
            }
            if temporary_table_name:
                table_endpoint = storage.get("primaryEndpoints", {}).get("table")
                if not isinstance(table_endpoint, str) or not table_endpoint.startswith("https://"):
                    raise RunnerError("Selected storage account has no valid Table Storage endpoint")
                storage_configuration.update({
                    "tableEndpoint": table_endpoint,
                    "mutationTableName": temporary_table_name,
                })
            configuration = {
                "schemaVersion": 1, "runId": run_id, "sourceSha256": source_hash,
                "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "imageDigest": digest, "storefrontHostname": site["defaultHostname"],
                "values": {key: value for key, value in d.values.items() if key in runtime_config.VALUE_KEYS and
                           not ((args.sql_only or args.mutations) and key.startswith("AUTH_TEST_CONSUMER_"))},
                "identity": {"clientId": identity["clientId"], "principalId": identity["principalId"],
                             "tenantId": account["tenantId"]},
                "storage": storage_configuration,
                "sql": {"host": sql["fullyQualifiedDomainName"], "database": d.required("SQL_DATABASE_NAME")},
                "localReport": {"checks": local.checks},
                "addressOnly": args.address_only,
                "browserOnly": args.browser_only,
                "sqlOnly": args.sql_only,
                "mutations": args.mutations,
            }
            parameters = {
                "jobName": ledger["jobName"], "location": environment["location"],
                "environmentName": environment["name"], "identityName": identity["name"],
                "registryName": registry["name"], "imageDigest": digest, "runId": run_id,
                "configuration": encode_configuration(configuration),
            }
            parameters_path = directory / "parameters.json"
            parameters_path.touch(mode=0o600)
            parameters_path.write_text(json.dumps({
                "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
                "contentVersion": "1.0.0.0", "parameters": {key: {"value": value} for key, value in parameters.items()},
            }))
            ledger["imageDigest"] = digest
            ledger["stage"] = "job-provisioning"
            ledger["computeCleanup"] = "provisioning"
            save()
            provision_attempted = True
            az("deployment", "group", "create", "-g", d.group, "--name", ledger["jobName"],
               "--template-file", str(ROOT / "infra/testing/auth-assurance-job.bicep"),
               "--parameters", "@" + str(parameters_path))
        job = az("containerapp", "job", "show", "-g", d.group, "-n", ledger["jobName"])
        check_job(job, ledger)
        ledger["stage"] = "job-start"
        save()
        execution = az("containerapp", "job", "start", "-g", d.group, "-n", ledger["jobName"])
        ledger["execution"] = execution["name"]
        ledger["stage"] = "execution-and-report-verification"
        save()
        summary = wait_result(az, ledger, 7500, lambda replica: log_lines(d.subscription, ledger, replica))
        ledger["uploaded"] = True
        ledger["result"] = summary
        ledger["stage"] = "report-verified"
        save()
    except (auth.EvidenceError, RunnerError, ValueError, KeyError, OSError, KeyboardInterrupt) as error:
        detail = str(error) if isinstance(error, (RunnerError, auth.EvidenceError)) else "Execution incomplete; raw details withheld"
        ledger["error"] = {"type": type(error).__name__, "stage": ledger["stage"], "detail": detail}
        save()
        print("Run incomplete; inspect/recover using " + str(path), file=sys.stderr)
        return 3
    finally:
        if provision_attempted:
            try:
                cleanup(az, ledger, save)
            except (auth.EvidenceError, RunnerError, OSError, KeyError) as error:
                ledger["computeCleanup"] = "unverified; use --cleanup with this ledger"
                ledger["cleanupError"] = {"type": type(error).__name__,
                    "detail": str(error) if isinstance(error, (auth.EvidenceError, RunnerError))
                    else "Cleanup incomplete; raw details withheld"}
                save()
                print("Temporary-job cleanup was not verified; see " + str(path), file=sys.stderr)
    if ledger["computeCleanup"] != "verified":
        return 3
    summary = ledger["result"]
    print("Outcome: " + summary["outcome"] + "; counts: " + json.dumps(summary["counts"]))
    print("Reports: " + storage["primaryEndpoints"]["blob"] + "adventureworks-receipts/" + ledger["reportPrefix"])
    print("Storage is private; report location is not an anonymous download link.")
    print("Temporary job deletion verified. Local ledger: " + str(path))
    return 1 if summary["outcome"] == "FAIL" else 2 if summary["outcome"] == "BLOCKED" else 0


if __name__ == "__main__":
    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        raise SystemExit(main())
    except (auth.EvidenceError, RunnerError, ValueError, KeyError, OSError) as error:
        print("Assurance runner preflight failed: " + str(error), file=sys.stderr)
        raise SystemExit(3)
