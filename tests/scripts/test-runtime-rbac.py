#!/usr/bin/env python3
"""Probe actual runtime MI permissions; email is opt-in and never retried automatically."""

import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import time
import urllib.request
import uuid

SPEC = importlib.util.spec_from_file_location("auth_validation", Path(__file__).parents[1] / "auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


def execute(deployment, app_name, script, *, marker="AUTH_RUNTIME_RBAC_RESULT", max_output=1024 * 1024,
            revision=None):
    master, slave = pty.openpty()
    args = ["az", "containerapp", "exec", "-g", deployment.group, "-n", app_name,
            "--subscription", deployment.subscription]
    if revision:
        args += ["--revision", revision]
    args += ["--command", "node"]
    process = subprocess.Popen(
        args, stdin=slave, stdout=slave, stderr=slave)
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
                if len(output) > max_output:
                    state = "do not retry an uncertain send" if sent else "no runtime send was attempted"
                    raise auth.EvidenceError("Runtime probe output exceeded its bound; " + state)
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
        results = re.findall(r"^(?:> )?" + re.escape(marker) + r":(\{[^\n]+\})$", text, re.MULTILINE)
        if not sent:
            raise auth.EvidenceError("Runtime probe source was not sent; no runtime send was attempted "
                                     f"(sourceSent=False, resultCount={len(results)}, bytes={len(output)})")
        if len(results) != 1:
            raise auth.EvidenceError("Runtime probe has no unique completed result; do not retry an uncertain send "
                                     f"(sourceSent={sent}, resultCount={len(results)}, "
                                     f"syntaxError={'SyntaxError' in text}, bytes={len(output)})")
        try:
            document = json.loads(results[0])
        except json.JSONDecodeError as error:
            raise auth.EvidenceError("Runtime probe returned malformed evidence; do not retry an uncertain send") from error
        if (not isinstance(document, dict) or not isinstance(document.get("checks"), list) or
                any(not isinstance(check, dict) or
                    any(not isinstance(check.get(key), str) for key in ("name", "status")) or
                    ("detail" in check and not isinstance(check["detail"], str)) or
                    (marker == "AUTH_RUNTIME_RBAC_RESULT" and not isinstance(check.get("detail"), str))
                    for check in document["checks"])):
            raise auth.EvidenceError("Runtime probe returned malformed evidence; do not retry an uncertain send")
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


def receiver_line(process, timeout):
    if process.stdout is None:
        raise auth.EvidenceError("Web PubSub receiver output is unavailable; capability URL withheld")
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) < 128:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise auth.EvidenceError("Web PubSub receiver timed out; capability URL withheld")
        chunk = os.read(process.stdout.fileno(), 1)
        if not chunk:
            raise auth.EvidenceError("Web PubSub receiver exited without evidence; capability URL withheld")
        if chunk == b"\n":
            try:
                return data.decode("ascii")
            except UnicodeDecodeError as error:
                raise auth.EvidenceError("Web PubSub receiver returned invalid evidence") from error
        data.extend(chunk)
    raise auth.EvidenceError("Web PubSub receiver output exceeded its bound")


def stop_receiver(process):
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    if process.stdout:
        process.stdout.close()


def start_webpubsub_receiver(deployment, *, identity="admin", group="utilities", probe_id=None):
    if (identity, group) not in {("admin", "utilities"), ("manufacturing", "manufacturing-agent")}:
        raise auth.EvidenceError("Unreviewed Web PubSub receiver identity or group")
    host, properties = auth.selected_webpubsub_resource(deployment)
    if properties.get("disableAadAuth") is not False:
        raise auth.EvidenceError("Selected Web PubSub does not confirm Entra authentication")
    helper = auth.load_auth_helper()
    base, audience = auth.internal_token_target(deployment, "functions")
    opener = urllib.request.build_opener(helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
    args = argparse.Namespace(identity=identity, command="token", timeout=120)
    try:
        session = helper.session(opener, args, base, audience)
    except (helper.AuthError, ValueError, OSError) as error:
        raise auth.EvidenceError("Functions session was unavailable; no push was attempted") from error
    token = session.get("access_token") if isinstance(session, dict) else None
    if not isinstance(token, str) or not token:
        raise auth.EvidenceError("Functions session was incomplete; no push was attempted")
    status, _, raw = auth.http(
        "GET", auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/webpubsub/negotiate",
        token=token)
    if status != 200:
        raise auth.EvidenceError(f"Web PubSub negotiation returned HTTP {status}; no push was attempted")
    groups, lifetime = auth.webpubsub_group_claims(raw)
    if group not in groups or not 0 < lifetime <= 3600:
        raise auth.EvidenceError("Capability does not have the bounded required group grant; no push was attempted")
    target = auth.webpubsub_socket_target(raw, host)
    probe_id = probe_id or str(uuid.uuid4())
    try:
        if str(uuid.UUID(probe_id, version=4)) != probe_id:
            raise ValueError("Invalid probe ID")
    except (ValueError, TypeError, AttributeError) as error:
        raise auth.EvidenceError("Web PubSub probe ID is invalid; no push was attempted") from error
    try:
        process = subprocess.Popen(
            ["node", str(Path(__file__).with_name("runtime-webpubsub-receiver.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as error:
        raise auth.EvidenceError("Web PubSub receiver is unavailable; no push was attempted") from error
    try:
        payload = {"url": "wss://" + host + target, "host": host, "probeId": probe_id}
        if group == "manufacturing-agent":
            payload["kind"] = "functions-step"
        process.stdin.write((json.dumps(payload) + "\n").encode())
        process.stdin.close()
        if receiver_line(process, 45) != "SOCKET_READY":
            raise auth.EvidenceError("Web PubSub receiver did not connect; no push was attempted")
    except (BrokenPipeError, OSError, auth.EvidenceError) as error:
        stop_receiver(process)
        if isinstance(error, auth.EvidenceError):
            raise
        raise auth.EvidenceError("Web PubSub receiver failed; no push was attempted") from error
    return process, {"host": host, "probeId": probe_id}


def mcp_signing_configuration_matches(app, identity, uri, certificate):
    try:
        attached = app["identity"]["userAssignedIdentities"]
        containers = app["properties"]["template"]["containers"]
        if not isinstance(attached, dict) or len(containers) != 1:
            raise ValueError("Unexpected MCP deployment")
        environment = containers[0]["env"]
        keys = {"MCP_SIGNING_KEY_VAULT_URI", "MCP_SIGNING_CERTIFICATE_NAME",
                "MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID"}
        items = [item for item in environment if item.get("name") in keys]
        if len(items) != len(keys) or {item["name"] for item in items} != keys:
            raise ValueError("Unexpected MCP signing configuration")
        configured = {item["name"]: item.get("value") for item in items}
        valid = (identity["id"].lower() in {key.lower() for key in attached} and
                 auth.mcp_keyvault_configuration_is_valid(configured, uri, certificate, identity["clientId"]))
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("Deployed MCP Key Vault signing configuration is incomplete") from error
    return valid


def selected_keyvault_config(deployment, identity):
    name = deployment.required("MCP_SIGNING_KEY_VAULT_NAME")
    uri = deployment.required("MCP_SIGNING_KEY_VAULT_URI")
    certificate = deployment.required("MCP_SIGNING_CERTIFICATE_NAME")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,127}", certificate):
        raise auth.EvidenceError("Selected signing certificate name is invalid")
    auth.key_vault_private_dns_zone_name(name, uri)
    vault = deployment.arm("Microsoft.KeyVault/vaults/" + name, "2023-07-01")
    properties = vault.get("properties") if isinstance(vault, dict) else None
    if (not isinstance(properties, dict) or properties.get("enableRbacAuthorization") is not True or
            properties.get("accessPolicies") or
            not auth.https_root_endpoints_match(properties.get("vaultUri"), uri)):
        raise auth.EvidenceError("Selected Key Vault URI or RBAC configuration does not match")
    app = deployment.azure("containerapp", "show", "-g", deployment.group,
                           "-n", deployment.required("SERVICE_API_MCP_NAME"))
    valid = mcp_signing_configuration_matches(app, identity, uri, certificate)
    if not valid:
        raise auth.EvidenceError("MCP signing configuration does not match the selected vault and runtime identity")
    return {"uri": auth.https_url(uri), "certificate": certificate}


def mcp_signing_provider_log(report, deployment, identity, keyvault):
    name = deployment.required("SERVICE_API_MCP_NAME")
    app = deployment.azure("containerapp", "show", "-g", deployment.group, "-n", name)
    properties = app.get("properties") if isinstance(app, dict) else None
    revision = properties.get("latestRevisionName") if isinstance(properties, dict) else None
    if (not isinstance(revision, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", revision) or
            properties.get("latestReadyRevisionName") != revision or
            properties.get("provisioningState") != "Succeeded" or properties.get("runningStatus") != "Running" or
            not mcp_signing_configuration_matches(app, identity, keyvault["uri"], keyvault["certificate"])):
        raise auth.EvidenceError("The selected MCP revision, readiness or signing identity is not confirmed")

    raw = auth.command([
        "az", "containerapp", "logs", "show", "--resource-group", deployment.group,
        "--name", name, "--subscription", deployment.subscription, "--revision", revision,
        "--type", "console", "--tail", "300", "--format", "json", "--only-show-errors",
    ], timeout=90)
    if len(raw.encode()) > 8 * 1024 * 1024:
        raise auth.EvidenceError("MCP startup-log response exceeded its bound; records withheld")
    pattern = re.compile(
        r"^(?:F\s+)?\s*Loaded MCP signing certificate '" + re.escape(keyvault["certificate"]) +
        r"' from Key Vault \(kid [A-Fa-f0-9]+, attempt [1-8]\)\.\s*$"
    )
    category = re.compile(
        r"^(?:F\s+)?\s*info: AdventureWorks\.Auth\.KeyVaultCertificateSigningKeyProvider\[\d+\]\s*$"
    )
    observed = False
    previous = ""
    try:
        for line in raw.splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if not isinstance(record, dict) or not isinstance(record.get("Log"), str):
                raise ValueError("Invalid record")
            message = record["Log"]
            matched = bool(pattern.fullmatch(message) and category.fullmatch(previous))
            previous = message
            if not matched:
                continue
            stamp = record.get("TimeStamp")
            if not isinstance(stamp, str):
                raise ValueError("Missing timestamp")
            normalized = re.sub(r"(\.\d{6})\d+(?=Z|[+-]|$)", r"\1", stamp).replace("Z", "+00:00")
            timestamp = datetime.fromisoformat(normalized)
            if timestamp.tzinfo is None or timestamp > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ValueError("Invalid timestamp")
            observed = True
    except (ValueError, TypeError) as error:
        raise auth.EvidenceError("MCP startup logs have an unsupported shape; records withheld") from error
    if not observed:
        raise auth.EvidenceError("Selected MCP replica's recent log does not contain the signing-provider startup event")
    current = deployment.azure("containerapp", "show", "-g", deployment.group, "-n", name)
    current_properties = current.get("properties") if isinstance(current, dict) else None
    if (not isinstance(current_properties, dict) or
            current_properties.get("latestRevisionName") != revision or
            current_properties.get("latestReadyRevisionName") != revision or
            current_properties.get("provisioningState") != "Succeeded" or
            current_properties.get("runningStatus") != "Running" or
            not mcp_signing_configuration_matches(current, identity, keyvault["uri"], keyvault["certificate"])):
        raise auth.EvidenceError("MCP revision or signing identity changed while checking startup logs")
    report.add("runtime-rbac:mcp-signing-provider", "runtime", "PASS",
               "One replica of the current ready MCP revision reported loading the selected signing certificate "
               "from Key Vault. "
               "Its configured client identity matches the shared UAMI; the provider's token was not inspected.")


def selected_service_profile(deployment, identity):
    app = deployment.azure("containerapp", "show", "-g", deployment.group,
                           "-n", deployment.required("SERVICE_API_MCP_NAME"))
    try:
        properties = app["properties"]
        revision = properties["latestRevisionName"]
        containers = properties["template"]["containers"]
        if (not isinstance(revision, str) or not revision or
                properties.get("latestReadyRevisionName") != revision or
                properties.get("provisioningState") != "Succeeded" or len(containers) != 1):
            raise ValueError("MCP revision is not ready")
        environment = containers[0]["env"]
        keys = {"MCP_TRUSTED_SERVICE_PRINCIPAL_IDS", "MCP_FUNCTIONS_PRINCIPAL_ID",
                "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID", "MCP_PUBLIC_BASE_URL", "MCP_RESOURCE_IDENTIFIER"}
        items = [item for item in environment if item.get("name") in keys]
        if len(items) != len({item["name"] for item in items}):
            raise ValueError("Duplicate MCP service configuration")
        configured = {item["name"]: item.get("value") for item in items}
        url = auth.https_url(deployment.required("API_MCP_URL"))
        origin = auth.origin(url)
        ingress = properties["configuration"]["ingress"]
        fqdn = ingress["fqdn"]
        if (not isinstance(fqdn, str) or not re.fullmatch(r"[a-z0-9.-]+", fqdn) or
                ingress.get("external") is not True or origin != "https://" + fqdn or
                url != origin + "/mcp" or auth.https_url(configured["MCP_PUBLIC_BASE_URL"]) != origin or
                configured.get("MCP_RESOURCE_IDENTIFIER", origin + "/mcp").rstrip("/") != origin + "/mcp"):
            raise ValueError("MCP target or audience does not match the selected environment")
        agent = auth.fetch_agents(deployment).get("manufacturing-agent", {})
        latest = agent["versions"]["latest"]
        hosted = latest["instance_identity"]["principal_id"]
        if (latest["definition"]["kind"] != "hosted" or
                not auth.mcp_service_profiles_match(configured, identity["principalId"], hosted) or
                auth.parse_principal_id_allowlist(configured["MCP_TRUSTED_SERVICE_PRINCIPAL_IDS"]) !=
                {str(uuid.UUID(identity["principalId"])), str(uuid.UUID(hosted))}):
            raise ValueError("MCP service trust or profile does not match the deployed identities")
        return {"origin": origin, "revision": revision, "hosted": str(uuid.UUID(hosted))}
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise auth.EvidenceError("Selected MCP revision and service identity profiles could not be confirmed") from error


def run(report, deployment, recipient, webpubsub=False, keyvault=False, service_profile=False):
    d = deployment
    report.provenance["azdEnvironment"] = d.environment
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
    if keyvault:
        config["keyVault"] = selected_keyvault_config(d, identity)
        report.add("runtime-rbac:keyvault-configuration", "runtime", "PASS",
                   "Selected vault, certificate and shared runtime identity match the deployed MCP configuration")
    if service_profile:
        selected_profile = selected_service_profile(d, identity)
        config["serviceProfile"] = {"origin": selected_profile["origin"]}
        report.inventory["serviceProfileProbe"] = {
            "revision": selected_profile["revision"],
            "identityOrigin": "Existing admin container using the shared runtime UAMI; not the Functions or hosted instance",
        }
    if recipient:
        config.update({"recipient": recipient, "communicationEndpoint": d.required("COMMUNICATION_SERVICE_ENDPOINT"),
                       "senderDomain": d.required("EMAIL_SENDER_DOMAIN")})
    fqdn = app["properties"]["configuration"]["ingress"]["fqdn"]
    status, _, _ = auth.http("GET", "https://" + fqdn)
    if status != 200:
        raise auth.EvidenceError("Existing admin site is not responsive; no runtime probe started")
    receiver = None
    ledger = {"app": app["name"], "emailRequested": bool(recipient), "webPubSubRequested": webpubsub,
              "keyVaultRequested": keyvault, "serviceProfileRequested": service_profile,
              "invocation": "pending", "completed": False}
    path = report.output / "runtime-rbac-ledger.json"
    path.write_text(json.dumps(ledger, indent=2) + "\n")
    try:
        if webpubsub:
            receiver, config["webPubSub"] = start_webpubsub_receiver(d)
            report.inventory["webPubSubProbe"] = {
                "host": config["webPubSub"]["host"], "group": "utilities",
                "sender": "existing admin container's shared runtime identity",
            }
        script = "globalThis.authRbacConfig=" + json.dumps(config) + ";\n"
        script += Path(__file__).with_name("runtime-rbac-probe.cjs").read_text()
        document = execute(d, app["name"], script)
        if service_profile:
            if selected_service_profile(d, identity) != selected_profile:
                raise auth.EvidenceError("MCP revision or service identity profiles changed during the runtime probe")
            report.add("runtime-rbac:service-profile-revision", "runtime", "PASS",
                       "The selected ready MCP revision and distinct workload profiles were unchanged during the probe")
        if webpubsub:
            sends = [check for check in document["checks"] if check.get("name") == "webpubsub-group-send"]
            if len(sends) == 1 and sends[0].get("status") == "PASS":
                try:
                    delivered = receiver_line(receiver, 30) == "MESSAGE_RECEIVED"
                except auth.EvidenceError as error:
                    report.add("runtime-rbac:webpubsub-delivery", "runtime", "FAIL",
                               "Runtime sent the marker, but the client could not confirm delivery: " + str(error))
                else:
                    detail = ("The connected admin client received the unique utilities-group marker from the "
                              "selected runtime identity; the marker itself makes no business write or email"
                              if delivered else
                              "Runtime sent the marker, but the client did not confirm delivery")
                    report.check("runtime-rbac:webpubsub-delivery", "runtime", delivered, detail)
            else:
                report.add("runtime-rbac:webpubsub-delivery", "runtime", "BLOCKED",
                           "Runtime group send was not confirmed; socket delivery was not asserted")
    finally:
        if receiver is not None:
            stop_receiver(receiver)
    ledger.update({"invocation": "returned", "completed": True})
    path.write_text(json.dumps(ledger, indent=2) + "\n")
    expected = {"storage-management-denied", "acr-management-denied", "acr-manifest-pull"}
    if recipient:
        expected.update({"email-send-authorized", "email-operation-succeeded"})
    if webpubsub:
        expected.update({"webpubsub-identity", "webpubsub-group-send"})
    if keyvault:
        expected.update({"keyvault-identity", "keyvault-signing-metadata"})
    if service_profile:
        expected.update({"service-profile-identity", "service-profile-catalogue-grant",
                         "service-profile-admin-denied", "service-profile-manufacturing-write-denied",
                         "service-profile-catalogue-tool", "service-profile-tool-denied"})
    for index, check in enumerate(document["checks"]):
        report.add("runtime-rbac:" + str(index), "runtime",
                   "PASS" if check.get("status") == "PASS" else "FAIL", check.get("name", "unknown") + ": " +
                   check.get("detail", "Missing runtime assertion detail"))
    report.check("runtime-rbac:complete", "runtime", len(document["checks"]) == len(expected) and
                 {check.get("name") for check in document["checks"]} == expected,
                 "Actual runtime MI denials, image pull and all explicitly requested producer assertions completed")
    if keyvault:
        report.guarded("runtime-rbac:mcp-signing-provider", "runtime",
                       lambda: mcp_signing_provider_log(report, d, identity, config["keyVault"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--send-email", action="store_true", help="Explicitly opt in to one approved test email")
    parser.add_argument("--webpubsub-probe", action="store_true",
                        help="Explicitly send one nonpersistent utilities-group marker and verify socket delivery")
    parser.add_argument("--keyvault-probe", action="store_true",
                        help="Read selected signing-secret version metadata and inspect MCP startup logs, never its value")
    parser.add_argument("--service-profile-probe", action="store_true",
                        help="Check shared-runtime service scopes and read-only MCP tool boundaries")
    args = parser.parse_args()
    recipient = os.environ.get("AUTH_RBAC_TEST_RECIPIENT") if args.send_email else None
    if args.send_email and (not recipient or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient)):
        parser.error("--send-email requires an approved address in AUTH_RBAC_TEST_RECIPIENT")
    output = auth.ROOT / ".auth-results" / ("runtime-rbac-" + str(uuid.uuid4()))
    output.mkdir()
    report = auth.Report(output)
    report.guarded("runtime-rbac:scenario", "runtime",
                   lambda: run(report, auth.Deployment(args.environment), recipient,
                               args.webpubsub_probe, args.keyvault_probe, args.service_profile_probe))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
