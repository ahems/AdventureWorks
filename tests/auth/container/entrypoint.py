#!/usr/bin/env python3
"""Private data-plane execution. No ARM/deployer credentials or infrastructure changes."""

import base64
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import socket
import ipaddress
import signal
import subprocess
import sys
from urllib.parse import urlsplit
import zlib

AUTH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTH))
from reporting import STATUSES, artifact_manifest, combine, pdf, render
import runtime_config
from ephemeral_storage import (
    RUN_ID_PATTERN, TemporaryTableCleanupError, TemporaryTableCreationError, temporary_table,
)

ROOT = AUTH.parents[1]


def execute(arguments, timeout, output):
    with output.open("wb") as stream:
        process = subprocess.Popen(arguments, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return 124
        except KeyboardInterrupt:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 130


def upload(configuration, directory, credential):
    from azure.storage.blob import BlobServiceClient, ContentSettings
    store = configuration["storage"]
    service = BlobServiceClient(store["endpoint"], credential=credential)
    container = service.get_container_client("adventureworks-receipts")
    manifest = artifact_manifest(directory)
    manifest_path = directory / "artifacts.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    for name in [*manifest, "artifacts.json"]:
        data = (directory / name).read_bytes()
        blob = container.get_blob_client(store["prefix"] + name)
        blob.upload_blob(data, overwrite=False, content_settings=ContentSettings(
            content_type=mimetypes.guess_type(name)[0] or "application/octet-stream"))
        received = blob.download_blob().readall()
        if hashlib.sha256(received).digest() != hashlib.sha256(data).digest():
            raise RuntimeError("Report blob readback checksum mismatch")
    return manifest


def temporary_storage_check(configuration, credential, service_factory=None, run_checks=None):
    storage = configuration.get("storage", {})
    table_name = storage.get("mutationTableName")
    endpoint = storage.get("tableEndpoint")
    if table_name is None and endpoint is None:
        if run_checks is not None:
            run_checks()
        return None
    if not isinstance(table_name, str) or not isinstance(endpoint, str):
        return {"checks": [{
            "id": "storage:temporary-assurance-table", "group": "private", "status": "BLOCKED",
            "detail": "Temporary table configuration is incomplete; no table operation was attempted.",
        }]}

    azure_error_types = ()
    if service_factory is None:
        try:
            from azure.core.exceptions import AzureError
            from azure.data.tables import TableServiceClient
            azure_error_types = (AzureError,)
            service_factory = lambda uri, token: TableServiceClient(uri, credential=token)
        except ImportError:
            return {"checks": [{
                "id": "storage:temporary-assurance-table", "group": "private", "status": "FAIL",
                "detail": "Azure Table Storage test dependency is unavailable.",
            }]}

    service = None
    in_checks = False
    ledger_entries = []
    try:
        service = service_factory(endpoint, credential)
        run_id = configuration.get("runId")
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("Assurance run identity is missing")
        with temporary_table(service, table_name) as table:
            table.create_entity({
                "PartitionKey": run_id,
                "RowKey": "persistence-probe",
                "RunId": run_id,
                "State": "created",
            })
            persisted = table.get_entity(run_id, "persistence-probe")
            if persisted.get("RunId") != run_id or persisted.get("State") != "created":
                raise RuntimeError("Temporary table persistence readback did not match")
            if run_checks is not None:
                in_checks = True
                run_checks()
                in_checks = False
            ledger_entries = [{
                key: value for key, value in entity.items()
                if key in {"PartitionKey", "RowKey", "kind", "state", "id", "owner", "marker", "entity", "label"}
            } for entity in table.query_entities(query_filter=f"PartitionKey eq '{run_id}'")
                if entity.get("RowKey") != "persistence-probe"]
    except TemporaryTableCreationError as error:
        if in_checks:
            raise
        status = "FAIL"
        detail = (f"Temporary table creation was not confirmed for {error.table_name}; "
                  "no deletion was attempted. Inspect the exact table before any cleanup.")
    except TemporaryTableCleanupError as error:
        status = "FAIL"
        detail = f"Temporary table cleanup failed for {error.table_name}; exact cleanup may be required."
    except azure_error_types as error:
        if in_checks:
            raise
        status = "BLOCKED"
        detail = (f"Temporary table {table_name} persistence was unavailable "
                  f"({type(error).__name__}); no application table was touched.")
    except (RuntimeError, ValueError) as error:
        if in_checks:
            raise
        status = "FAIL"
        detail = f"Temporary table {table_name} persistence assertion failed ({type(error).__name__})."
    else:
        status = "PASS"
        detail = f"Temporary table {table_name} persisted a run marker and was removed."
    finally:
        if service is not None:
            service.close()

    return {
        "checks": [{
            "id": "storage:temporary-assurance-table", "group": "private",
            "status": status, "detail": detail,
        }],
        "mutationLedger": ledger_entries,
    }


def key_vault_dns_check(configuration):
    values = configuration.get("values")
    values = values if isinstance(values, dict) else {}
    name = values.get("MCP_SIGNING_KEY_VAULT_NAME")
    uri = values.get("MCP_SIGNING_KEY_VAULT_URI")
    check = {
        "id": "keyvault-private-dns", "group": "private", "status": "BLOCKED",
        "detail": "Selected Key Vault hostname or private DNS resolution is unavailable; no secret was read.",
    }
    if not isinstance(name, str) or not name or not isinstance(uri, str):
        return check
    try:
        parsed = urlsplit(uri)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
                parsed.port not in {None, 443} or parsed.path not in {"", "/"} or
                parsed.query or parsed.fragment or
                not parsed.hostname.lower().startswith(name.lower() + ".vault.")):
            return check
        addresses = {entry[4][0] for entry in socket.getaddrinfo(parsed.hostname, 443)}
        if not addresses:
            return check
        ranges = [ipaddress.ip_network(value) for value in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]]
        private = all(any(ipaddress.ip_address(address) in network for network in ranges) for address in addresses)
    except (socket.gaierror, ValueError, TypeError):
        return check
    check["status"] = "PASS" if private else "FAIL"
    check["detail"] = ("The selected Key Vault's normal hostname must resolve exclusively to private IPv4 "
                       "addresses inside the job; no secret was read.")
    return check


def private_checks(configuration, root):
    if configuration.get("browserOnly") is True:
        return []
    documents = []
    private = {"checks": []}
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(configuration["sql"]["host"], 1433)}
        private["checks"].append({
            "id": "sql-private-dns", "group": "private",
            "status": "PASS" if addresses and all(ipaddress.ip_address(item).is_private for item in addresses) else "FAIL",
            "detail": "SQL normal FQDN must resolve exclusively to private addresses from this job.",
        })
    except socket.gaierror:
        private["checks"].append({"id": "sql-private-dns", "group": "private", "status": "BLOCKED",
                                  "detail": "SQL DNS resolution failed; no network or firewall settings changed."})
    if not any(configuration.get(flag) for flag in ["addressOnly", "sqlOnly", "mutations"]):
        private["checks"].append(key_vault_dns_check(configuration))
    documents.append(("private-dns", private))
    sql_output = root / "sql.log"
    sql_exit = execute(["dotnet", "run", "--project", "tests/auth/private/PrivateProbe.csproj",
                        "--no-restore", "--verbosity", "quiet"], 180, sql_output)
    sql_documents = []
    for line in sql_output.read_text(errors="replace").splitlines():
        if line.startswith('{"checks":'):
            sql_documents.append(json.loads(line))
    document = sql_documents[0] if len(sql_documents) == 1 else {"checks": [{
        "id": "execution", "group": "private", "status": "BLOCKED",
        "detail": "Private SQL probe did not return one complete structured result; exit " + str(sql_exit),
    }]}
    if configuration.get("sqlOnly") is True or configuration.get("mutations") is True:
        validate_sql_evidence(document, sql_exit)
    documents.append(("private-sql", document))
    if not any(configuration.get(flag) for flag in ["addressOnly", "sqlOnly", "mutations"]):
        from workload_probe import workload_checks
        documents.append(("private-mcp-workload", workload_checks(configuration)))
    return documents


def validate_sql_evidence(document, exit_code):
    required = {"shared-uami", "sql:identity:current-user:external-client-sid",
                "sql:required-metadata:Production.ProductReview:default-definitions",
                "sql:required-metadata:Production.ProductReview:defaults-present",
                "sql:required-metadata:Production.ProductReview:view-definition",
                "sql:database-execute:database:EXECUTE", "sql:shared-data-access-exception"}
    required.update("sql:forbidden-role:" + role + ":membership" for role in [
        "db_owner", "db_securityadmin", "db_accessadmin", "db_ddladmin", "db_backupoperator"])
    required.update("sql:required-role:" + role + ":membership" for role in ["db_datareader", "db_datawriter"])
    required.update("sql:database-admin:database:" + permission for permission in [
        "CONTROL", "ALTER", "ALTER ANY ROLE", "ALTER ANY USER", "ALTER ANY SCHEMA",
        "CREATE TABLE", "CREATE PROCEDURE", "CREATE FUNCTION", "CREATE VIEW", "CREATE SCHEMA",
        "TAKE OWNERSHIP", "ALTER ANY DATABASE SCOPED CONFIGURATION"])
    required.update("sql:inventory:" + kind for kind in [
        "user-impersonate", "schema-admin", "object-admin", "table-data", "routine-execute"])
    checks = document.get("checks")
    failed = isinstance(checks, list) and any(isinstance(item, dict) and item.get("status") == "FAIL"
                                             for item in checks)
    valid = (isinstance(checks, list) and all(isinstance(item, dict) and isinstance(item.get("id"), str) and
             item.get("group") in {"private", "sql-effective"} and
             item.get("status") in {"PASS", "FAIL", "BLOCKED", "ACCEPTED_EXCEPTION"} and
             isinstance(item.get("detail"), str) and bool(item["detail"]) for item in checks))
    if not valid:
        document.clear()
        document["checks"] = []
        checks = document["checks"]
    ids = [item["id"] for item in checks]
    outcome_code = 1 if any(item["status"] == "FAIL" for item in checks) else \
        2 if any(item["status"] == "BLOCKED" for item in checks) else 0
    valid = (valid and len(ids) == len(set(ids)) and required <= set(ids) and exit_code == outcome_code and
             all(item["status"] != "ACCEPTED_EXCEPTION" or item["id"] == "sql:shared-data-access-exception"
                 for item in checks) and
             all(item["status"] == "ACCEPTED_EXCEPTION" for item in checks
                 if item["id"] == "sql:shared-data-access-exception"))
    if not valid:
        # A partial or contradictory probe cannot erase an observed permission failure.
        document["checks"] = [{"id": "effective-permissions-incomplete", "group": "sql-effective",
                               "status": "FAIL" if failed else "BLOCKED",
                               "detail": "SQL effective-permission evidence incomplete, malformed, duplicated or inconsistent "
                                         "with process exit; no SQL coverage claimed."}]


def suite_arguments(configuration):
    if configuration.get("mutations") is True:
        return ["tests/auth/mutation_suite.py"]
    if configuration.get("sqlOnly") is True:
        return []
    if configuration.get("browserOnly") is True:
        return ["tests/auth/validate.py", "--browsers"]
    if configuration.get("addressOnly") is True:
        return ["tests/auth/address_fixture_suite.py"]
    return ["tests/auth/validate.py", "--all"]


def reconcile_unit_evidence(local, suite):
    unit_gates = {
        "required:entra-assertion-real-signature-negatives",
        "required:functions-worker-middleware",
        "required:address-handler-ownership",
        "required:password-handler-ownership",
        "required:receipt-handler-ownership",
        "required:consumer-handlers-offline",
        "required:guest-cart-service-lifecycle",
        "required:mcp-tool-http-dispatch",
        "required:mcp-task-ownership-offline",
    }
    suite_checks = suite.get("checks", [])
    for check in local.get("checks", []):
        if (check.get("id") not in unit_gates or check.get("group") != "required" or
                check.get("status") != "BLOCKED" or
                not check.get("detail", "").endswith("Evidence SHA256: {}")):
            continue
        matching = [item for item in suite_checks if item.get("id") == check["id"]]
        if len(matching) == 1 and matching[0].get("group") == "required" and matching[0].get("status") == "PASS":
            check["status"] = "NOT_APPLICABLE"
            check["detail"] += (" Local infrastructure inspection does not run unit tests; "
                                "the private suite passed this exact current-run evidence gate.")

    host_id = "required:functions-middleware-host-denials"
    local_host = [check for check in local.get("checks", []) if check.get("id") == host_id]
    private_host = [check for check in suite_checks if check.get("id") == host_id]
    if (len(local_host) == 1 and len(private_host) == 1 and
            local_host[0].get("group") == private_host[0].get("group") == "required" and
            local_host[0].get("status") == "PASS" and private_host[0].get("status") == "BLOCKED" and
            private_host[0].get("detail") ==
            "Required coverage obligation is not established by registry or helper tests"):
        private_host[0].update(status="NOT_APPLICABLE", detail=(
            "The same-run local control plane passed the exact loopback-only worker gate. "
            "The private job does not repeat namespace-isolated host tests; this is not deployed-host evidence."))


def reconcile_host_mutation_denials(suite, mutations, exit_code):
    if exit_code != 0:
        return
    operations = {
        "SetPassword:POST": "password-set",
        "VerifyPassword:POST": "password-verify",
        "UpdateAddress:PUT": "address-update",
        "SetAddressType:PUT": "address-type",
        "DeleteAddress:DELETE": "address-delete",
        "CreateAddress:POST": "address-create",
        "CreateCategory:POST": "category-create",
        "CreateSubcategory:POST": "subcategory-create",
    }
    evidence = mutations.get("checks", [])
    for check in suite.get("checks", []):
        for operation, label in operations.items():
            if (check.get("id") != "functions:" + operation + ":deny" or
                    check.get("group") != "live-denials" or check.get("status") != "BLOCKED" or
                    check.get("detail") !=
                    "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears"):
                continue
            expected = {f"mutation:host-denial-{label}-{owner}-{credential}{suffix}"
                        for owner in ["A", "B"] for credential in ["anonymous", "forged", "dab-audience"]
                        for suffix in ["", "-unchanged"]}
            if label == "address-create":
                expected.update(f"mutation:host-denial-{label}-{owner}-{credential}-baseline"
                                for owner in ["A", "B"] for credential in ["anonymous", "forged", "dab-audience"])
                expected.add("mutation:address-create-marker-control")
            if label in {"category-create", "subcategory-create"}:
                expected.update(f"mutation:host-denial-{label}-{owner}-{credential}{suffix}"
                                for owner in ["A", "B"]
                                for credential in ["anonymous", "forged", "dab-audience", "consumer"]
                                for suffix in ["", "-baseline", "-unchanged"])
                expected.add(f"mutation:{label}-marker-control")
                expected.update(f"mutation:host-dab-token-control-{owner}" for owner in ["A", "B"])
            selected = [item for item in evidence if item.get("id") in expected]
            if len(selected) == len(expected) and {item["id"] for item in selected} == expected and all(
                    item.get("status") == "PASS" and
                    item.get("group") == ("mutations" if item["id"].endswith(("-unchanged", "-baseline")) or
                                          item["id"].endswith("-marker-control") or
                                          item["id"].startswith("mutation:host-dab-token-control-")
                                          else "live-denials")
                    for item in selected):
                check["status"] = "PASS"
                check["detail"] = ("Two run-owned consumers: anonymous, forged and wrong-audience requests "
                                   "returned exact host denials and independent fixture reads remained unchanged; "
                                   + ("private SQL detects linked and orphan rows. " if label == "address-create" else "")
                                   + ("consumer Functions tokens were also denied, and marker-filtered public reads "
                                      "proved no new catalog name. " if label in
                                      {"category-create", "subcategory-create"} else "")
                                   + "See mutation host-denial assertions. Other authorization cases remain separate.")


def valid_address_inventory(inventory, run_id):
    if not isinstance(inventory, dict):
        return False
    residuals = inventory.get("addressFixtureResiduals", [])
    if not isinstance(residuals, list):
        return False
    if not residuals:
        return True
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        return False
    marker = "AuthAssurance-" + run_id[-36:].replace("-", "")
    required = {"kind", "owner", "marker", "state"}
    for item in residuals:
        if (not isinstance(item, dict) or not required <= set(item) or
                set(item) - (required | {"id"}) or
                not isinstance(item["kind"], str) or
                item["kind"] not in {"address-fixture", "address-fixture-link"} or
                type(item["owner"]) is not int or item["owner"] <= 0 or item["marker"] != marker or
                not isinstance(item["state"], str) or
                item["state"] not in {"creation-requested", "created", "deleted"} or
                ("id" in item and (type(item["id"]) is not int or item["id"] <= 0)) or
                ("id" not in item and (item["state"] != "creation-requested" or
                                       item["kind"] == "address-fixture-link"))):
            return False
    return True


def run_profile(configuration, root, documents):
    documents.extend(private_checks(configuration, root))
    output = root / "suite"
    suite = suite_arguments(configuration)
    mutation_document = None
    if suite:
        exit_code = execute(["python3", "-B", *suite, "--output", str(output)], 5400, root / "suite.log")
        address_only = configuration.get("addressOnly") is True
        suite_document = None
        try:
            candidate = json.loads((output / "report.json").read_text())
        except (OSError, ValueError):
            candidate = None
        checks = candidate.get("checks") if isinstance(candidate, dict) else None
        if (isinstance(checks, list) and checks and all(
                isinstance(check, dict) and
                all(isinstance(check.get(key), str) and check[key] for key in ["id", "group", "status", "detail"]) and
                check["status"] in STATUSES for check in checks) and
                len({check["id"] for check in checks}) == len(checks) and
                (not address_only or valid_address_inventory(candidate.get("inventory"), configuration.get("runId")))):
            suite_document = candidate
        if suite_document is not None:
            documents.append(("suite", suite_document))
            if address_only and exit_code in {0, 1, 2}:
                statuses = {check["status"] for check in suite_document["checks"]}
                outcome = "FAIL" if "FAIL" in statuses else "BLOCKED" if "BLOCKED" in statuses else "PASS"
                if suite_document.get("outcome") != outcome or exit_code != {"PASS": 0, "FAIL": 1, "BLOCKED": 2}[outcome]:
                    documents.append(("execution", {"checks": [{
                        "id": "inconsistent", "group": "runner", "status": "FAIL",
                        "detail": "Address fixture report and process exit disagree; fixture cleanup is unverified.",
                    }]}))
        else:
            documents.append(("suite", {"checks": [{
                "id": "execution", "group": "runner", "status": "FAIL" if address_only else "BLOCKED",
                "detail": ("Address fixture suite returned no complete report; fixture cleanup is unverified; exit "
                           if address_only else "Suite returned no complete report; exit ") + str(exit_code),
            }]}))
        if exit_code not in {0, 1, 2}:
            documents.append(("execution", {"checks": [{"id": "incomplete", "group": "runner",
                                                       "status": "FAIL" if address_only else "BLOCKED",
                                                       "detail": "Suite interrupted or timed out; fixture cleanup requires review."}]}))
        if suite == ["tests/auth/validate.py", "--all"]:
            suite_document = next((document for phase, document in documents if phase == "suite"), {})
            reconcile_unit_evidence(configuration["localReport"], suite_document)
            mutation_output = root / "mutations"
            mutation_exit = execute(["python3", "-B", "tests/auth/mutation_suite.py",
                                     "--output", str(mutation_output)], 5400, root / "mutations.log")
            if (mutation_output / "report.json").is_file():
                mutation_document = json.loads((mutation_output / "report.json").read_text())
            else:
                mutation_document = {"checks": [{"id": "execution", "group": "runner", "status": "BLOCKED",
                                                 "detail": "Mutation suite returned no report; exit " +
                                                 str(mutation_exit)}]}
            documents.append(("mutations", mutation_document))
            if mutation_exit not in {0, 1, 2}:
                documents.append(("mutation-execution", {"checks": [{
                    "id": "incomplete", "group": "runner", "status": "BLOCKED",
                    "detail": "Mutation suite interrupted or timed out; residual fixtures require review."}]}))
            reconcile_host_mutation_denials(suite_document, mutation_document, mutation_exit)
    return mutation_document


def run():
    raw = os.environ.pop("AUTH_ASSURANCE_CONFIG_B64")
    decompressor = zlib.decompressobj()
    decoded = decompressor.decompress(base64.b64decode(raw, validate=True), 1024 * 1024)
    if decompressor.unconsumed_tail or not decompressor.eof:
        raise ValueError("Invalid or oversized secure configuration")
    configuration = json.loads(decoded)
    del raw
    root = Path("/tmp/assurance")
    root.mkdir(mode=0o700, exist_ok=False)
    manifest_path = root / "configuration.json"
    manifest_path.touch(mode=0o600)
    manifest_path.write_text(json.dumps(configuration))
    os.environ["AUTH_ASSURANCE_MANIFEST_FILE"] = str(manifest_path)
    runtime_config.load()
    prefix = configuration["storage"]["prefix"]
    if prefix != "auth-assurance/" + configuration["runId"] + "/":
        raise ValueError("Invalid run-owned report prefix")
    from azure.identity import ManagedIdentityCredential
    credential = ManagedIdentityCredential(client_id=configuration["identity"]["clientId"])
    documents = [("local-infra", configuration["localReport"])]
    started = datetime.now(timezone.utc).isoformat()
    mutation_result = [None]

    def run_checks():
        mutation_result[0] = run_profile(configuration, root, documents)

    storage_check = temporary_storage_check(configuration, credential, run_checks=run_checks)
    if storage_check is not None:
        mutation_ledger = storage_check.pop("mutationLedger", [])
        documents.append(("temporary-storage", storage_check))
    else:
        mutation_ledger = []
    mutation_document = mutation_result[0]
    provenance = {
        "runId": configuration["runId"], "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "environment": configuration["values"]["AZURE_ENV_NAME"],
        "sourceRevision": configuration["sourceRevision"], "sourceSha256": configuration["sourceSha256"],
        "imageDigest": configuration["imageDigest"],
        "computeCleanup": "Pending local-deployer verification; this process cannot delete its job.",
        "reportContainer": "adventureworks-receipts", "reportPrefix": prefix,
        "ordersRequested": False,
        "profile": "mutations" if configuration.get("mutations") else "sql" if configuration.get("sqlOnly") else "browsers" if configuration.get("browserOnly") else
                   "addresses" if configuration.get("addressOnly") else "all",
    }
    if configuration.get("mutations"):
        provenance["baseline"] = "Self-arranged; no unused/pristine seed prerequisite"
        suite_document = next((document for phase, document in documents if phase == "suite"), {})
        provenance["residuals"] = suite_document.get("inventory", {}).get("mutationResiduals", [])
    elif configuration.get("addressOnly"):
        suite_document = next((document for phase, document in documents if phase == "suite"), {})
        provenance["addressFixtureResiduals"] = suite_document.get("inventory", {}).get("addressFixtureResiduals", [])
    elif mutation_document is not None:
        provenance["mutationBaseline"] = "Self-arranged; no unused/pristine seed prerequisite"
        provenance["mutationResiduals"] = mutation_document.get("inventory", {}).get("mutationResiduals", [])
    if mutation_ledger:
        provenance["mutationLedger"] = mutation_ledger
    report = combine(documents, provenance)
    published = root / "published"
    render(report, published)
    try:
        pdf(published)
    except (RuntimeError, subprocess.TimeoutExpired):
        documents.append(("reporting", {"checks": [{"id": "pdf", "group": "runner", "status": "FAIL",
                                                   "detail": "PDF generation failed; other report formats retained."}]}))
        report = combine(documents, provenance)
        render(report, published)
    try:
        manifest = upload(configuration, published, credential)
    finally:
        credential.close()
        manifest_path.unlink(missing_ok=True)
    summary = {"runId": configuration["runId"], "outcome": report["outcome"], "counts": report["counts"],
               "uploaded": True, "artifacts": manifest, "prefix": prefix}
    print("AUTH_ASSURANCE_RESULT:" + json.dumps(summary, separators=(",", ":")), flush=True)
    return 1 if report["outcome"] == "FAIL" else 2 if report["outcome"] == "BLOCKED" else 0


if __name__ == "__main__":
    from azure.core.exceptions import AzureError

    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        raise SystemExit(run())
    except (OSError, ValueError, KeyError, RuntimeError, AzureError, zlib.error) as error:
        print("AUTH_ASSURANCE_ERROR:" + type(error).__name__ +
              "; execution/report persistence incomplete; raw details withheld", flush=True)
        raise SystemExit(3)
