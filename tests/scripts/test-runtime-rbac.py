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
import urllib.request
import uuid

SPEC = importlib.util.spec_from_file_location("auth_validation", Path(__file__).parents[1] / "auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


def execute(deployment, app_name, script, *, marker="AUTH_RUNTIME_RBAC_RESULT", max_output=1024 * 1024):
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
                    any(not isinstance(check.get(key), str) for key in ("name", "status", "detail"))
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


def start_webpubsub_receiver(deployment):
    host, properties = auth.selected_webpubsub_resource(deployment)
    if properties.get("disableAadAuth") is not False:
        raise auth.EvidenceError("Selected Web PubSub does not confirm Entra authentication")
    helper = auth.load_auth_helper()
    base, audience = auth.internal_token_target(deployment, "functions")
    opener = urllib.request.build_opener(helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
    args = argparse.Namespace(identity="admin", command="token", timeout=120)
    try:
        session = helper.session(opener, args, base, audience)
    except (helper.AuthError, ValueError, OSError) as error:
        raise auth.EvidenceError("Admin Functions session was unavailable; no push was attempted") from error
    token = session.get("access_token") if isinstance(session, dict) else None
    if not isinstance(token, str) or not token:
        raise auth.EvidenceError("Admin Functions session was incomplete; no push was attempted")
    status, _, raw = auth.http(
        "GET", auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/webpubsub/negotiate",
        token=token)
    if status != 200:
        raise auth.EvidenceError(f"Web PubSub negotiation returned HTTP {status}; no push was attempted")
    groups, lifetime = auth.webpubsub_group_claims(raw)
    if "utilities" not in groups or not 0 < lifetime <= 3600:
        raise auth.EvidenceError("Admin capability does not have a bounded utilities grant; no push was attempted")
    target = auth.webpubsub_socket_target(raw, host)
    probe_id = str(uuid.uuid4())
    try:
        process = subprocess.Popen(
            ["node", str(Path(__file__).with_name("runtime-webpubsub-receiver.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as error:
        raise auth.EvidenceError("Web PubSub receiver is unavailable; no push was attempted") from error
    try:
        process.stdin.write((json.dumps({"url": "wss://" + host + target, "host": host, "probeId": probe_id}) +
                             "\n").encode())
        process.stdin.close()
        if receiver_line(process, 45) != "SOCKET_READY":
            raise auth.EvidenceError("Web PubSub receiver did not connect; no push was attempted")
    except (BrokenPipeError, OSError, auth.EvidenceError) as error:
        stop_receiver(process)
        if isinstance(error, auth.EvidenceError):
            raise
        raise auth.EvidenceError("Web PubSub receiver failed; no push was attempted") from error
    return process, {"host": host, "probeId": probe_id}


def run(report, deployment, recipient, webpubsub=False):
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
    if recipient:
        config.update({"recipient": recipient, "communicationEndpoint": d.required("COMMUNICATION_SERVICE_ENDPOINT"),
                       "senderDomain": d.required("EMAIL_SENDER_DOMAIN")})
    fqdn = app["properties"]["configuration"]["ingress"]["fqdn"]
    status, _, _ = auth.http("GET", "https://" + fqdn)
    if status != 200:
        raise auth.EvidenceError("Existing admin site is not responsive; no runtime probe started")
    receiver = None
    ledger = {"app": app["name"], "emailRequested": bool(recipient), "webPubSubRequested": webpubsub,
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
    for index, check in enumerate(document["checks"]):
        report.add("runtime-rbac:" + str(index), "runtime",
                   "PASS" if check.get("status") == "PASS" else "FAIL", check.get("name", "unknown") + ": " +
                   check.get("detail", "Missing runtime assertion detail"))
    report.check("runtime-rbac:complete", "runtime", len(document["checks"]) == len(expected) and
                 {check.get("name") for check in document["checks"]} == expected,
                 "Actual runtime MI denials, image pull and all explicitly requested producer assertions completed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--send-email", action="store_true", help="Explicitly opt in to one approved test email")
    parser.add_argument("--webpubsub-probe", action="store_true",
                        help="Explicitly send one nonpersistent utilities-group marker and verify socket delivery")
    args = parser.parse_args()
    recipient = os.environ.get("AUTH_RBAC_TEST_RECIPIENT") if args.send_email else None
    if args.send_email and (not recipient or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient)):
        parser.error("--send-email requires an approved address in AUTH_RBAC_TEST_RECIPIENT")
    output = auth.ROOT / ".auth-results" / ("runtime-rbac-" + str(uuid.uuid4()))
    output.mkdir()
    report = auth.Report(output)
    report.guarded("runtime-rbac:scenario", "runtime",
                   lambda: run(report, auth.Deployment(args.environment), recipient, args.webpubsub_probe))
    return report.save()


if __name__ == "__main__":
    raise SystemExit(main())
