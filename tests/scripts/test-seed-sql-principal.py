#!/usr/bin/env python3
"""Verify the seed identity's SQL session through a non-seeding execution override."""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("auth_validation", ROOT / "tests/auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)

TERMINAL = {"Succeeded", "Failed", "Stopped"}
FIELDS = {"token", "database", "session", "control", "catalog", "runtimePrincipal",
          "runtimeDataRoles", "runtimeExecute", "externalAdminRoles", "externalInventory",
          "externalRoleClosure", "externalDatabaseAdminGrants", "externalScopedAdminGrants"}
ROLE_COUNTS = {"transitivePrivilegedRoleCount", "truncatedRolePathCount",
               "publicRoleCount", "privilegedDatabaseGrantCount", "privilegedScopedGrantCount"}
COUNT_FIELDS = {"principalCount", "privilegedExternalRoleCount", "runtimeExplicitDenies",
                "permissionEntries"} | ROLE_COUNTS
PHASES = {"connect", "token", "sql-connect", "sql-query", "complete", "cleanup"}
PLATFORM_OTEL_ENV = {
    "CONTAINERAPP_OTEL_LOGGING_GRPC_ENDPOINT", "CONTAINERAPP_OTEL_METRIC_GRPC_ENDPOINT",
    "CONTAINERAPP_OTEL_TRACING_GRPC_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_SERVICE_NAME",
}


class EvidenceNotReady(auth.EvidenceError):
    pass


def selected_account(deployment):
    selected = auth.command(["azd", "env", "get-value", "AZURE_ENV_NAME", "--no-prompt"]).strip()
    account = auth.json_command(["az", "account", "show", "--query", "{id:id,tenantId:tenantId}", "-o", "json"])
    try:
        if (selected != deployment.environment or
                uuid.UUID(account["id"]) != uuid.UUID(deployment.subscription)):
            raise ValueError("Selected environment or subscription differs")
        return str(uuid.UUID(account["tenantId"]))
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("Selected azd environment or active Azure account is not pinned") from error


def snapshot(deployment):
    d = deployment
    tenant = selected_account(d)
    seed_name = d.required("SEED_MANAGED_IDENTITY_NAME")
    runtime_name = d.required("USER_MANAGED_IDENTITY_NAME")
    server_name = d.required("SQL_SERVER_NAME")
    database_name = d.required("SQL_DATABASE_NAME")
    job_name = d.required("SERVICE_SEED_JOB_NAME")
    registry = d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT").lower()
    seed = d.azure("identity", "show", "-g", d.group, "-n", seed_name)
    runtime = d.azure("identity", "show", "-g", d.group, "-n", runtime_name)
    server = d.azure("sql", "server", "show", "-g", d.group, "-n", server_name)
    database = d.azure("sql", "db", "show", "-g", d.group, "-s", server_name, "-n", database_name)
    job = d.azure("containerapp", "job", "show", "-g", d.group, "-n", job_name)
    registries = d.azure("acr", "list", "-g", d.group)
    cloud = auth.json_command(["az", "cloud", "show", "--query",
                               "{name:name,suffix:suffixes.sqlServerHostname}", "-o", "json"])
    try:
        suffixes = {
            "AzureCloud": ".database.windows.net",
            "AzureUSGovernment": ".database.usgovcloudapi.net",
            "AzureChinaCloud": ".database.chinacloudapi.cn",
        }
        client = str(uuid.UUID(seed["clientId"]))
        principal = str(uuid.UUID(seed["principalId"]))
        runtime_client = str(uuid.UUID(runtime["clientId"]))
        runtime_principal = str(uuid.UUID(runtime["principalId"]))
        template = job["properties"]["template"]
        configuration = job["properties"]["configuration"]
        container, = template["containers"]
        registry_config, = configuration["registries"]
        registry_resource, = [item for item in registries if item["loginServer"].lower() == registry]
        attached = {key.lower() for key in job["identity"]["userAssignedIdentities"]}
        sql_host = server["fullyQualifiedDomainName"].lower()
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", seed_name) or
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", runtime_name) or
                not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", server_name) or
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", database_name) or
                not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", job_name) or
                not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", registry) or
                suffixes.get(cloud["name"]) != cloud["suffix"] or
                sql_host != server_name + cloud["suffix"] or
                server["name"] != server_name or database["name"] != database_name or
                database["status"] != "Online" or
                server["administrators"].get("azureAdOnlyAuthentication") is not True or
                not auth.seed_sql_admin_matches(server["administrators"], seed, tenant) or
                seed["name"] != seed_name or runtime["name"] != runtime_name or
                runtime["id"].lower() == seed["id"].lower() or
                runtime_client == client or runtime_principal == principal or
                job["identity"]["type"] != "UserAssigned" or attached != {seed["id"].lower()} or
                configuration["triggerType"] != "Manual" or configuration["replicaRetryLimit"] != 0 or
                configuration.get("manualTriggerConfig", {}).get("parallelism", 1) != 1 or
                configuration.get("manualTriggerConfig", {}).get("replicaCompletionCount", 1) != 1 or
                template.get("initContainers") or
                registry_config["server"].lower() != registry or
                registry_config["identity"].lower() != seed["id"].lower() or
                registry_config.get("username") or registry_config.get("passwordSecretRef") or
                container["name"] != job_name or
                container["image"].lower() != registry + "/seed-job:latest"):
            raise ValueError("Unexpected seed job, SQL target or identity")
        image = d.azure("acr", "repository", "show", "-n", registry_resource["name"],
                        "--image", "seed-job:latest")
        digest = image["digest"]
        if not isinstance(digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
            raise ValueError("The seed image does not have a valid immutable digest")
        return {
            "jobId": job["id"], "jobName": job_name, "identity": job["identity"],
            "template": template, "configuration": configuration, "seed": seed, "runtime": runtime,
            "server": server, "database": database, "tenantId": tenant,
            "probeImage": registry + "/seed-job@" + digest,
            "probe": {"seedName": seed_name, "clientId": client, "principalId": principal,
                      "runtimeName": runtime_name, "runtimeClientId": runtime_client,
                      "tenantId": tenant, "sqlHost": sql_host, "database": database_name},
        }
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("The selected seed identity, administrator, SQL target or job is not safely bound") from error


def require_no_active_executions(deployment, job_name):
    executions = deployment.azure("containerapp", "job", "execution", "list",
                                  "-g", deployment.group, "-n", job_name)
    if (not isinstance(executions, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("properties"), dict) or
            item["properties"].get("status") not in TERMINAL
            for item in executions)):
        raise auth.EvidenceError("A seed job execution may be active; no diagnostic was started")


def probe_template(template, config, source, image):
    try:
        container, = template["containers"]
        if template.get("initContainers") or not isinstance(container, dict):
            raise ValueError("Unexpected containers")
        nonce = config["nonce"]
        for key in ["clientId", "principalId", "runtimeClientId", "tenantId"]:
            uuid.UUID(config[key])
        if (set(config) != {"nonce", "clientId", "principalId", "runtimeClientId", "runtimeName",
                           "tenantId", "sqlHost", "database", "seedName"} or
                not isinstance(nonce, str) or re.fullmatch(r"[a-f0-9]{32}", nonce) is None or
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", config["seedName"]) or
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", config["runtimeName"]) or
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", config["database"]) or
                not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", config["sqlHost"]) or
                not isinstance(image, str) or
                not re.fullmatch(r"[a-z0-9][a-z0-9.-]*/seed-job@sha256:[0-9a-f]{64}", image) or
                not isinstance(source, str) or not source):
            raise ValueError("Invalid diagnostic configuration")
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("Diagnostic execution template is invalid") from error
    result = copy.deepcopy(template)
    target = result["containers"][0]
    serialized = json.dumps(config, separators=(",", ":"), ensure_ascii=True).replace("'", "''")
    target["command"] = ["pwsh"]
    target["image"] = image
    target["args"] = ["-NoLogo", "-NoProfile", "-Command",
                      "$seedProbeConfig = '" + serialized + "' | ConvertFrom-Json\n" + source]
    target["env"] = []
    target["volumeMounts"] = []
    result["volumes"] = []
    return result


def execution_matches(observed, expected):
    try:
        actual_container, = observed["containers"]
        expected_container, = expected["containers"]
        env = actual_container.get("env") or []
        names = [item.get("name") for item in env if isinstance(item, dict)]
        return (
            not observed.get("initContainers") and not observed.get("volumes") and
            not actual_container.get("volumeMounts") and
            actual_container["name"] == expected_container["name"] and
            actual_container["image"] == expected_container["image"] and
            actual_container["command"] == expected_container["command"] and
            actual_container["args"] == expected_container["args"] and
            isinstance(env, list) and len(names) == len(env) == len(set(names)) and all(
                item["name"] in PLATFORM_OTEL_ENV and set(item) <= {"name", "value"} and
                isinstance(item.get("value"), str) for item in env)
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def parse_evidence(log, nonce):
    if not isinstance(log, str) or len(log) > 1024 * 1024:
        raise auth.EvidenceError("Diagnostic logs are unavailable or exceed their bound; output withheld")
    marker = "AUTH_SEED_SQL_PRINCIPAL:" + nonce + ":"
    lines = [line.split(marker, 1)[1] for line in log.splitlines() if marker in line]
    if not lines:
        raise EvidenceNotReady("Diagnostic result is not yet available; output withheld")
    if len(lines) != 1 or len(lines[0]) > 4096:
        raise auth.EvidenceError("Exactly one diagnostic result is required; output withheld")
    try:
        result = json.loads(lines[0])
        keys = FIELDS | COUNT_FIELDS | {"status", "phase", "dbo", "owner"}
        if (not isinstance(result, dict) or set(result) != keys or result["phase"] not in PHASES or
                result["status"] not in {"PASS", "FAIL", "BLOCKED"} or
                any(result[field] not in {"PASS", "FAIL", "BLOCKED"} for field in FIELDS) or
                (result["dbo"] is not None and type(result["dbo"]) is not bool) or
                (result["owner"] is not None and type(result["owner"]) is not bool) or
                any(result[field] is not None and
                    (type(result[field]) is not int or result[field] < 0) for field in COUNT_FIELDS) or
                (result["status"] == "PASS" and
                 (result["phase"] != "complete" or any(result[field] != "PASS" for field in FIELDS) or
                  result["principalCount"] != 1 or result["privilegedExternalRoleCount"] != 0 or
                  result["runtimeExplicitDenies"] is None or not result["permissionEntries"])) or
                (result["status"] == "FAIL" and all(result[field] != "FAIL" for field in FIELDS)) or
                (result["status"] == "BLOCKED" and any(result[field] == "FAIL" for field in FIELDS))):
            raise ValueError("Unsupported result shape")
        direct = result["privilegedExternalRoleCount"]
        if (result["externalAdminRoles"] !=
                ("BLOCKED" if direct is None else "FAIL" if direct else "PASS")):
            raise ValueError("Direct role status disagrees with the observed count")
        role_counts = [result[field] for field in ROLE_COUNTS]
        if all(value is None for value in role_counts):
            if any(result[field] != "BLOCKED" for field in
                   ["externalRoleClosure", "externalDatabaseAdminGrants", "externalScopedAdminGrants"]):
                raise ValueError("Missing role-closure evidence")
        else:
            if (any(value is None for value in role_counts) or result["principalCount"] is None or
                    result["privilegedExternalRoleCount"] is None or
                    result["privilegedExternalRoleCount"] > result["transitivePrivilegedRoleCount"] or
                    (result["principalCount"] == 0 and
                     (result["transitivePrivilegedRoleCount"] or result["privilegedDatabaseGrantCount"] or
                      result["privilegedScopedGrantCount"]))):
                raise ValueError("Inconsistent role-closure evidence")
            complete = result["principalCount"] > 0 and result["truncatedRolePathCount"] == 0
            expected_roles = ("FAIL" if result["transitivePrivilegedRoleCount"] else
                              "PASS" if complete else "BLOCKED")
            expected_grants = ("FAIL" if result["privilegedDatabaseGrantCount"] else
                               "PASS" if complete and result["publicRoleCount"] == 1 else "BLOCKED")
            expected_scoped_grants = ("FAIL" if result["privilegedScopedGrantCount"] else
                                      "PASS" if complete and result["publicRoleCount"] == 1 else "BLOCKED")
            if (result["externalRoleClosure"] != expected_roles or
                    result["externalDatabaseAdminGrants"] != expected_grants or
                    result["externalScopedAdminGrants"] != expected_scoped_grants):
                raise ValueError("Role-closure statuses disagree with the observed counts")
        return result
    except (ValueError, KeyError, TypeError) as error:
        raise auth.EvidenceError("Diagnostic result is malformed or inconsistent; output withheld") from error


def execution_log(deployment, job, execution, container):
    replicas = deployment.azure("containerapp", "job", "replica", "list", "-g", deployment.group,
                                "-n", job, "--execution", execution)
    if isinstance(replicas, list) and not replicas:
        raise EvidenceNotReady("The diagnostic replica is not yet available")
    if not isinstance(replicas, list) or len(replicas) != 1:
        raise auth.EvidenceError("The exact diagnostic replica is unavailable or ambiguous")
    name = replicas[0].get("name") if isinstance(replicas[0], dict) else None
    if not isinstance(name, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", name) is None:
        raise auth.EvidenceError("The diagnostic replica name is invalid")
    return auth.command([
        "az", "containerapp", "job", "logs", "show", "--subscription", deployment.subscription,
        "-g", deployment.group, "-n", job, "--execution", execution, "--replica", name,
        "--container", container, "--tail", "300", "--format", "text", "--only-show-errors",
    ], timeout=90)


def completed_evidence(deployment, job, execution, container, nonce):
    for attempt in range(6):
        try:
            return parse_evidence(execution_log(deployment, job, execution, container), nonce)
        except EvidenceNotReady:
            if attempt == 5:
                raise
            time.sleep(5)


def run(report, deployment, timeout):
    d = deployment
    if d.runtime:
        raise auth.EvidenceError("Seed principal inspection requires the local deployment identity")
    before = snapshot(d)
    require_no_active_executions(d, before["jobName"])
    nonce = uuid.uuid4().hex
    config = {**before["probe"], "nonce": nonce}
    source = Path(__file__).with_name("seed-sql-principal-probe.ps1").read_text()
    template = probe_template(before["template"], config, source, before["probeImage"])
    ledger = {"runId": nonce, "environment": d.environment, "job": before["jobName"],
              "state": "not-started", "execution": None, "executionStatus": None}
    path = report.output / "seed-sql-principal-ledger.json"

    def save():
        path.write_text(json.dumps(ledger, indent=2) + "\n")

    report.provenance.update({"azdEnvironment": d.environment,
                              "probeSha256": hashlib.sha256(source.encode()).hexdigest(),
                              "probeImageDigest": before["probeImage"].rsplit("@", 1)[1]})
    save()
    if snapshot(d) != before:
        raise auth.EvidenceError("Seed identity, SQL target or job changed before the diagnostic")
    require_no_active_executions(d, before["jobName"])
    ledger["state"] = "start-uncertain"
    save()
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as handle:
            json.dump(template, handle)
            handle.flush()
            started = d.azure("containerapp", "job", "start", "-g", d.group, "-n", before["jobName"],
                              "--yaml", handle.name)
        name = started.get("name") if isinstance(started, dict) else None
        if (not isinstance(name, str) or
                re.fullmatch(re.escape(before["jobName"]) + r"-[a-z0-9-]{1,96}", name) is None):
            raise auth.EvidenceError("Diagnostic start is unconfirmed; inspect its ledger before any retry")
        ledger.update({"state": "running", "execution": name})
        save()
        deadline = time.monotonic() + timeout
        execution = None
        while time.monotonic() < deadline:
            execution = d.azure("containerapp", "job", "execution", "show", "-g", d.group,
                                "-n", before["jobName"], "--job-execution-name", name)
            if not isinstance(execution, dict) or not isinstance(execution.get("properties"), dict):
                raise auth.EvidenceError("Diagnostic execution metadata is malformed; inspect its exact ledger")
            status = execution["properties"].get("status")
            if not isinstance(status, str) or not status:
                raise auth.EvidenceError("Diagnostic execution status is unavailable; inspect its exact ledger")
            ledger["executionStatus"] = status
            save()
            if status in TERMINAL:
                break
            time.sleep(5)
        else:
            raise auth.EvidenceError("Diagnostic execution did not finish; inspect its exact ledger before retry")
        ledger["state"] = "finished"
        save()
        properties = execution.get("properties", {})
        expected_id = before["jobId"].rstrip("/") + "/executions/" + name
        if (str(execution.get("id", "")).lower() != expected_id.lower() or execution.get("name") != name or
                not execution_matches(properties.get("template", {}), template)):
            report.add("seed-sql:execution-binding", "infra", "FAIL",
                       "The exact execution did not preserve the no-seed command, identity-bound image and empty mounts.")
            return
        report.add("seed-sql:execution-binding", "infra", "PASS",
                   "The exact execution used the reviewed no-seed command, digest-pinned image and no mounted volumes.")
        if status == "Stopped":
            raise auth.EvidenceError("The exact read-only diagnostic execution was stopped")
        evidence = completed_evidence(d, before["jobName"], name, template["containers"][0]["name"], nonce)
        if (status == "Succeeded") != (evidence["status"] == "PASS"):
            report.add("seed-sql:execution-result", "infra", "FAIL",
                       "The execution status disagrees with its sanitized diagnostic result.")
            return
        for field, detail in {
            "token": "The SQL token's tenant, principal, client and audience matched the selected seed identity.",
            "database": "The SQL session selected the configured database.",
            "session": "The SQL session login name or SID matched the selected seed identity.",
            "control": "The seed SQL session has database CONTROL, as expected for the bootstrap administrator.",
            "catalog": "The seed SQL session read nonempty principal and explicit-permission metadata counts.",
            "runtimePrincipal": "The selected runtime identity's name and client SID matched one contained Entra user.",
            "runtimeDataRoles": "The runtime contained user has direct reader and writer role memberships.",
            "runtimeExecute": "The runtime contained user has a direct database EXECUTE grant.",
            "externalAdminRoles": "No contained Entra principal has a direct privileged fixed-role membership.",
            "externalInventory": "The selected runtime identity is the only contained Entra principal observed.",
            "externalRoleClosure": "Selected privileged fixed database roles were checked through all observed "
                                   "contained Entra principal role paths; truncated traversal is not a pass.",
            "externalDatabaseAdminGrants": "Selected database-scope administrative GRANT records were checked "
                                           "for contained Entra principals, nested roles and public; "
                                           "this is not a complete effective-permission or ownership inventory.",
            "externalScopedAdminGrants": "Selected object, schema and principal administrative GRANT records "
                                        "and GRANT OPTION permissions at any database permission class were checked "
                                        "for contained Entra principals, nested roles and public; "
                                        "this is not a complete effective-permission or ownership inventory.",
        }.items():
            report.add("seed-sql:" + field, "infra", evidence[field], detail)
        report.inventory["seedSqlPrincipal"] = {
            "execution": name, "dbo": evidence["dbo"], "dbOwner": evidence["owner"],
            "externalPrincipalCount": evidence["principalCount"], "phase": evidence["phase"],
            "privilegedExternalRoleMemberships": evidence["privilegedExternalRoleCount"],
            "runtimeExplicitDenies": evidence["runtimeExplicitDenies"],
            "explicitPermissionEntries": evidence["permissionEntries"],
            "transitivePrivilegedRoleMemberships": evidence["transitivePrivilegedRoleCount"],
            "truncatedRolePaths": evidence["truncatedRolePathCount"],
            "publicRoleCount": evidence["publicRoleCount"],
            "privilegedDatabaseGrantEntries": evidence["privilegedDatabaseGrantCount"],
            "privilegedScopedGrantEntries": evidence["privilegedScopedGrantCount"],
        }
        if evidence["control"] == "PASS" and evidence["session"] == "PASS":
            report.add("seed-sql:bootstrap-admin-exception", "exceptions", "ACCEPTED_EXCEPTION",
                       "The dedicated seed identity is SQL administrator for bootstrap; this is not runtime least privilege.")
    finally:
        try:
            unchanged = snapshot(d) == before
        except auth.EvidenceError:
            report.add("seed-sql:job-unchanged", "infra", "BLOCKED",
                       "The selected identity, SQL target or stored job could not be rechecked.")
        else:
            report.check("seed-sql:job-unchanged", "infra", unchanged,
                         "The selected identity, SQL target, image digest and stored job template were unchanged.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    if not 30 <= args.timeout <= 1800:
        parser.error("--timeout must be between 30 and 1800")
    output = auth.ROOT / ".auth-results" / ("seed-sql-principal-" + str(uuid.uuid4()))
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = auth.Report(output)
    report.guarded("seed-sql:scenario", "infra", lambda: run(report, auth.Deployment(args.environment), args.timeout))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
