#!/usr/bin/env python3
"""Verify an actual Functions publisher with one exactly cleaned test run fixture."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import re
import urllib.request
import uuid

SPEC = importlib.util.spec_from_file_location("runtime_rbac_probe", Path(__file__).with_name("test-runtime-rbac.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
auth = runtime.auth
FIXTURE_SOURCE = Path(__file__).with_name("runtime-functions-push-fixture.cjs")


def discover(deployment):
    apps = deployment.azure("containerapp", "list", "-g", deployment.group)
    if not isinstance(apps, list) or not all(isinstance(app, dict) for app in apps):
        raise auth.EvidenceError("Container App inventory is incomplete")
    selected = [app for app in apps if app.get("tags", {}).get("azd-service-name") == "app-admin"]
    if len(selected) != 1:
        raise auth.EvidenceError("Cannot discover the existing admin container for the fixture")
    app = selected[0]
    identity = deployment.azure("identity", "show", "-g", deployment.group,
                                "-n", deployment.required("USER_MANAGED_IDENTITY_NAME"))
    storage = deployment.azure("storage", "account", "show", "-g", deployment.group,
                               "-n", deployment.required("STORAGE_ACCOUNT_NAME"))
    account = deployment.azure("account", "show")
    try:
        attached = app["identity"]["userAssignedIdentities"]
        identity_id, client_id, principal_id = identity["id"], identity["clientId"], identity["principalId"]
        storage_id, storage_name = storage["id"], storage["name"]
        table_endpoint, tenant_id = storage["primaryEndpoints"]["table"], account["tenantId"]
        app_name = app["name"]
        fqdn = app["properties"]["configuration"]["ingress"]["fqdn"]
        strings = [identity_id, client_id, principal_id, storage_id, storage_name,
                   table_endpoint, tenant_id, app_name, fqdn]
        if not isinstance(attached, dict) or any(not isinstance(value, str) or not value for value in strings):
            raise ValueError("Incomplete metadata")
    except (KeyError, TypeError, ValueError) as error:
        raise auth.EvidenceError("Selected fixture deployment metadata is incomplete") from error
    if identity_id.lower() not in {key.lower() for key in attached}:
        raise auth.EvidenceError("Admin container is not attached to the selected runtime identity")
    endpoint = auth.https_url(table_endpoint) + "/"
    if storage_name != deployment.required("STORAGE_ACCOUNT_NAME"):
        raise auth.EvidenceError("Storage account does not match the selected environment")
    status, _, _ = auth.http("GET", "https://" + fqdn)
    if status != 200:
        raise auth.EvidenceError("Existing admin site is not responsive; no fixture was created")
    return {
        "app": app_name, "storageResourceId": storage_id,
        "tableEndpoint": endpoint, "clientId": client_id,
        "principalId": principal_id, "tenantId": tenant_id,
    }


def manufacturing_token(deployment, resource="functions"):
    helper = auth.load_auth_helper()
    base, audience = auth.internal_token_target(deployment, resource)
    opener = urllib.request.build_opener(helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
    args = argparse.Namespace(identity="manufacturing", command="token", timeout=120)
    try:
        session = helper.session(opener, args, base, audience)
    except (helper.AuthError, ValueError, OSError) as error:
        raise auth.EvidenceError(f"Manufacturing {resource} session is unavailable") from error
    token = session.get("access_token") if isinstance(session, dict) else None
    if not isinstance(token, str) or not token:
        raise auth.EvidenceError(f"Manufacturing {resource} session is incomplete")
    return token


def consumer_token(report, deployment):
    try:
        consumers = auth.retained_consumer_fixtures(report, deployment)
        return consumers[0].token("functions", "mcp.access products.read")
    except auth.EvidenceError as error:
        report.add("functions-push:deny-insufficient-scope", "live-denials", "BLOCKED",
                   "A retained consumer is required for a real missing-scope denial. " + str(error))
        return None


def dab_control(report, deployment, token):
    role = auth.load_auth_helper().IDENTITIES["manufacturing"][4]
    status, _, raw = auth.http(
        "POST", auth.https_url(deployment.required("API_URL")), token=token,
        headers={"X-MS-API-ROLE": role},
        data={"query": "{ products(first: 1) { items { ProductID } } }"},
    )
    try:
        body = json.loads(raw)
        items = body["data"]["products"]["items"]
        valid = (status == 200 and not body.get("errors") and isinstance(items, list) and bool(items) and
                 type(items[0]["ProductID"]) is int)
    except (ValueError, KeyError, TypeError, IndexError):
        valid = False
    report.check("functions-push:dab-token-control", "live-allows", valid,
                 "The same manufacturing DAB token must first read an actual product")
    if not valid:
        raise auth.EvidenceError("DAB positive control failed; no fixture was created")


def denied_callbacks(report, deployment, url, payload, dab_token, consumer):
    metadata = auth.origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"
    cases = [
        ("anonymous", None, 401, "missing_token"),
        ("forged", "invalid-auth-validation-token", 401, "invalid_token"),
        ("wrong-audience", dab_token, 401, "invalid_token"),
    ]
    if consumer:
        cases.append(("insufficient-scope", consumer, 403, "insufficient_scope"))
    for label, token, expected_status, expected_error in cases:
        status, headers, raw = auth.http("POST", url, token=token, data=payload)
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        challenge = next((value for key, value in headers.items() if key.lower() == "www-authenticate"), "")
        valid = (status == expected_status and isinstance(body, dict) and body.get("error") == expected_error and
                 challenge.startswith("Bearer ") and f'resource_metadata="{metadata}"' in challenge and
                 f'error="{expected_error}"' in challenge)
        report.check("functions-push:deny-" + label, "live-denials", valid,
                     f"Valid fixture callback denied {label} with HTTP {status} and {expected_error}")
        if not valid:
            raise auth.EvidenceError("A callback denial failed; no remaining callbacks were sent")


def save_ledger(path, ledger):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(ledger, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def fixture_operation(deployment, discovered, ledger, operation, expected_step="unknown"):
    config = {key: discovered[key] for key in ("tableEndpoint", "clientId", "principalId", "tenantId")}
    config.update({"probeId": ledger["probeId"], "enqueuedAt": ledger["enqueuedAt"],
                   "operation": operation, "expectedStep": expected_step})
    script = "globalThis.authFunctionsPushFixture=" + json.dumps(config) + ";\n" + FIXTURE_SOURCE.read_text()
    return runtime.execute(deployment, discovered["app"], script, marker="AUTH_FUNCTIONS_PUSH_FIXTURE")


def emit_checks(report, phase, document):
    checks = document["checks"]
    if len({item["name"] for item in checks}) != len(checks):
        raise auth.EvidenceError("Fixture helper returned duplicate assertions")
    for index, item in enumerate(checks):
        report.add(f"functions-push:{phase}:{index}", "runtime",
                   "PASS" if item["status"] == "PASS" else "FAIL", item["name"] + ": " + item["detail"])
    return {item["name"]: item["status"] for item in checks}


def cleanup(report, deployment, discovered, ledger, ledger_path, expected_step):
    try:
        document = fixture_operation(deployment, discovered, ledger, "cleanup", expected_step)
        checks = emit_checks(report, "cleanup", document)
    except auth.EvidenceError as error:
        ledger["cleanup"] = "unconfirmed"
        save_ledger(ledger_path, ledger)
        report.add("functions-push:cleanup", "runtime", "BLOCKED",
                   "Exact fixture cleanup is unconfirmed; preserve the ledger for recovery. " + str(error))
        return
    identity_ok = checks.get("fixture-identity") == "PASS"
    absent = checks.get("fixture-absent") == "PASS"
    deleted = checks.get("fixture-deleted") == "PASS"
    settled = ledger["creation"] == "confirmed" or deleted
    if identity_ok and absent and settled:
        ledger["cleanup"] = "confirmed"
        report.add("functions-push:cleanup", "runtime", "PASS",
                   "The exact run-owned fixture is absent; no other table entity was deleted")
    else:
        ledger["cleanup"] = "unconfirmed"
        report.add("functions-push:cleanup", "runtime", "BLOCKED",
                   "Fixture ownership, deletion or a possibly late insert is unconfirmed; preserve the ledger")
    save_ledger(ledger_path, ledger)


def run(report, deployment):
    report.provenance["azdEnvironment"] = deployment.environment
    report.add("functions-push:scope", "scope", "PASS",
               "One temporary manufacturing-run fixture and one authenticated step callback; "
               "no queue, order, AI inference or email. Only the exact fixture is deleted.")
    discovered = discover(deployment)
    token = manufacturing_token(deployment)
    dab_token = manufacturing_token(deployment, "dab")
    dab_control(report, deployment, dab_token)
    consumer = consumer_token(report, deployment)
    probe_id = str(uuid.uuid4())
    ledger_path = report.output / "fixture-ledger.json"
    ledger = {
        "version": 1, "environment": deployment.environment, "probeId": probe_id,
        "enqueuedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "storageResourceId": discovered["storageResourceId"], "principalId": discovered["principalId"],
        "app": discovered["app"], "creation": "not-requested", "cleanup": "not-needed",
    }
    save_ledger(ledger_path, ledger)
    receiver, _ = runtime.start_webpubsub_receiver(
        deployment, identity="manufacturing", group="manufacturing-agent", probe_id=probe_id)
    callback_succeeded = False
    try:
        ledger.update({"creation": "requested", "cleanup": "pending"})
        save_ledger(ledger_path, ledger)
        try:
            document = fixture_operation(deployment, discovered, ledger, "create")
        except auth.EvidenceError as error:
            if "source was not sent" in str(error):
                ledger.update({"creation": "not-created", "cleanup": "not-needed"})
                save_ledger(ledger_path, ledger)
            raise
        checks = emit_checks(report, "create", document)
        if checks.get("fixture-absent-before") == "FAIL":
            ledger.update({"creation": "not-created", "cleanup": "not-needed"})
        elif checks.get("fixture-created") == "PASS":
            ledger["creation"] = "confirmed"
        save_ledger(ledger_path, ledger)
        expected = {"fixture-identity", "fixture-absent-before", "fixture-created", "fixture-confirmed",
                    "fixture-baseline-etag"}
        baseline = document.get("etagSha256")
        valid = (set(checks) == expected and all(value == "PASS" for value in checks.values()) and
                 isinstance(baseline, str) and re.fullmatch(r"[a-f0-9]{64}", baseline) is not None)
        report.check("functions-push:fixture-ready", "runtime", valid,
                     "A unique fixture must be created and read back before the callback")
        if not valid:
            raise auth.EvidenceError("Fixture creation was not confirmed; no callback was sent")
        url = auth.https_url(deployment.required("API_FUNCTIONS_URL"))
        url += "/api/manufacturing/agent-runs/" + probe_id + "/step"
        payload = {
            "key": "auth-assurance-" + probe_id, "label": "Authentication assurance", "status": "started",
        }
        denied_callbacks(report, deployment, url, payload, dab_token, consumer)
        inspection = fixture_operation(deployment, discovered, ledger, "inspect")
        checks = emit_checks(report, "inspect", inspection)
        valid = (set(checks) == {"fixture-identity", "fixture-owned", "fixture-no-steps", "fixture-baseline-etag"}
                 and all(value == "PASS" for value in checks.values()) and
                 inspection.get("etagSha256") == baseline)
        report.check("functions-push:denials-unchanged", "live-denials", valid,
                     "After the denied callbacks, the exact fixture has no steps and its ETag is unchanged")
        if not valid:
            raise auth.EvidenceError("Denied callback state was not unchanged; no authorized callback was sent")
        status, _, _ = auth.http("POST", url, token=token, data=payload)
        callback_succeeded = status == 204
        report.check("functions-push:callback", "runtime", callback_succeeded,
                     f"Authenticated manufacturing step callback returned HTTP {status}")
        if callback_succeeded:
            try:
                delivered = runtime.receiver_line(receiver, 60) == "MESSAGE_RECEIVED"
            except auth.EvidenceError as error:
                report.add("functions-push:delivery", "runtime", "FAIL",
                           "Functions callback completed but correlated socket delivery was not confirmed: " + str(error))
            else:
                report.check("functions-push:delivery", "runtime", delivered,
                             "The socket must receive the unique step event from the actual Functions callback")
    finally:
        try:
            runtime.stop_receiver(receiver)
        finally:
            if ledger["creation"] not in {"not-requested", "not-created"}:
                cleanup(report, deployment, discovered, ledger, ledger_path,
                        "present" if callback_succeeded else "unknown")


def recover(report, deployment, ledger_path):
    try:
        ledger = json.loads(ledger_path.read_text())
        probe_id = ledger["probeId"]
        valid = (ledger["version"] == 1 and ledger["environment"] == deployment.environment and
                 str(uuid.UUID(probe_id, version=4)) == probe_id and
                 isinstance(ledger["enqueuedAt"], str) and ledger["creation"] in {"requested", "confirmed"})
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise auth.EvidenceError("Fixture recovery ledger is invalid") from error
    if not valid:
        raise auth.EvidenceError("Fixture recovery ledger does not match the selected environment")
    discovered = discover(deployment)
    if (not isinstance(ledger.get("storageResourceId"), str) or
            ledger["storageResourceId"].lower() != discovered["storageResourceId"].lower() or
            ledger.get("principalId") != discovered["principalId"] or ledger.get("app") != discovered["app"]):
        raise auth.EvidenceError("Fixture recovery target no longer matches the original deployment")
    report.provenance["azdEnvironment"] = deployment.environment
    cleanup(report, deployment, discovered, ledger, ledger_path, "unknown")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--recover", type=Path, help="Recover the exact fixture recorded by a previous run")
    args = parser.parse_args()
    output = auth.ROOT / ".auth-results" / ("functions-push-" + str(uuid.uuid4()))
    output.mkdir(mode=0o700, parents=True)
    report = auth.Report(output)
    report.guarded("functions-push:scenario", "runtime",
                   lambda: recover(report, auth.Deployment(args.environment), args.recover)
                   if args.recover else run(report, auth.Deployment(args.environment)))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
