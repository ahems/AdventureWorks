#!/usr/bin/env python3
"""Exercise the actual Functions worker in a network-isolated local host."""

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

from validate import function_surface_inventory, route_path


ROOT = Path(__file__).resolve().parents[2]
UNCLASSIFIED = "AuthAssuranceUnclassified"
DENIALS = (
    "missing-token", "malformed-token", "wrong-signature", "wrong-issuer",
    "dab-audience", "mcp-audience", "expired", "not-before",
    "missing-expiration", "missing-subject", "missing-category", "unknown-category", "insufficient-scope",
)
ALTERNATE_METHODS = ("HEAD", "OPTIONS")
DESTRUCTIVE_CONTROLS = (
    ("ManufacturingStop", "POST", "manufacturing/stop", False),
    ("ClearManufacturingAgentQueue", "DELETE", "manufacturing/agent-queue", True),
    ("ClearManufacturingAgentPoisonQueue", "DELETE", "manufacturing/agent-queue/poison", True),
    ("ShoppingSimulator_ClearQueue", "POST", "shopping-simulator/clear-queue", True),
    ("AutoPromotion_ResetCounters", "POST", "auto-promotion/reset-counters", False),
)
CONTROLS = (
    "host:control:public-health", "host:control:unclassified",
    "host:control:valid-token", "host:control:expiry-skew",
    "host:control:not-before-skew", "host:control:guest-cart-denial",
    "host:control:delegated-chat-denial", "host:control:destructive-reset-dependency-failure",
) + tuple("host:control:blocked-" + item[0] for item in DESTRUCTIVE_CONTROLS)


class HostFailure(Exception):
    pass


def expected_case_ids(inventory):
    cases = list(CONTROLS)
    surfaces = function_surface_inventory(inventory)
    declared = {(item["route"].strip("/").lower(), item["method"])
                for item in surfaces if item["kind"] == "http"}
    for surface in surfaces:
        if surface["kind"] != "http":
            continue
        policy = surface["policy"]
        if (type(policy.get("IsAnonymous")) is not bool or
                policy.get("FunctionName") != surface["name"] or not isinstance(policy.get("Mode"), str)):
            raise HostFailure("Functions host policy inventory is incomplete")
        if policy["IsAnonymous"]:
            continue
        prefix = surface["id"] + ":"
        cases.extend(prefix + scenario for scenario in DENIALS)
        if policy["Mode"] == "InternalOnly":
            cases.append(prefix + "consumer-category")
        for method in ALTERNATE_METHODS:
            if (surface["route"].strip("/").lower(), method) not in declared:
                cases.append(prefix + "unsupported-" + method)
    if len(cases) != len(set(cases)):
        raise HostFailure("Duplicate Functions host case IDs")
    return cases


def inventory_digest(inventory):
    encoded = json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def verify_metadata(inventory, metadata):
    reflected = {item["Name"]: item for item in inventory}
    actual = {item["name"]: item for item in metadata}
    if len(reflected) != len(inventory) or len(actual) != len(metadata):
        raise HostFailure("Duplicate reflected or generated Functions metadata")
    if set(actual) != set(reflected) | {UNCLASSIFIED}:
        raise HostFailure("Built Functions metadata differs from the reflected inventory")
    disabled = []
    for name, item in reflected.items():
        http = [binding for binding in actual[name]["bindings"] if binding.get("type") == "httpTrigger"]
        if item["Route"] is None:
            if http:
                raise HostFailure("A reflected non-HTTP function acquired an HTTP trigger")
            disabled.append(name)
            continue
        if len(http) != 1:
            raise HostFailure("HTTP trigger metadata is incomplete")
        route = http[0].get("route") or name
        methods = sorted(method.upper() for method in http[0].get("methods", []))
        if route != item["Route"] or methods != sorted(item["Methods"]):
            raise HostFailure(f"Generated route or methods differ for {name}")
    extra = actual[UNCLASSIFIED]["bindings"]
    if not any(item.get("type") == "httpTrigger" and
               item.get("route") == "__auth-assurance/unclassified" for item in extra):
        raise HostFailure("The isolated unclassified-function probe is missing")
    return sorted(disabled)


def b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class LocalIssuer:
    def __init__(self, directory):
        self.key = directory / "issuer.key"
        self.other_key = directory / "other.key"
        for key in (self.key, self.other_key):
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
                 "-pkeyopt", "rsa_keygen_pubexp:65537", "-out", str(key)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        modulus = subprocess.run(
            ["openssl", "rsa", "-in", str(self.key), "-noout", "-modulus"],
            check=True, capture_output=True, text=True, timeout=10).stdout.strip()
        if not modulus.startswith("Modulus="):
            raise HostFailure("Unable to create local signing metadata")
        number = bytes.fromhex(modulus.removeprefix("Modulus="))
        self.jwk = {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "assurance",
                    "n": b64url(number), "e": "AQAB"}
        self.identity_requests = 0
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self.handler())
        self.server.daemon_threads = True
        self.issuer = f"http://127.0.0.1:{self.server.server_port}/"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def handler(self):
        issuer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/identity"):
                    issuer.identity_requests += 1
                    body = {"error": "invalid_request", "error_description": "isolated test"}
                    status = 400
                elif self.path == "/.well-known/openid-configuration":
                    body = {"issuer": issuer.issuer, "jwks_uri": issuer.issuer + "jwks"}
                    status = 200
                elif self.path == "/jwks":
                    body = {"keys": [issuer.jwk]}
                    status = 200
                else:
                    self.send_error(404)
                    return
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, _format, *_args):
                pass

        return Handler

    def token(self, *, scope="assurance.ungranted", category="employee", changes=None,
              remove=(), other_key=False):
        now = int(time.time())
        claims = {"iss": self.issuer, "aud": self.issuer + "functions",
                  "sub": "synthetic-owner", "scope": scope, "category": category,
                  "business_entity_id": 1, "customer_id": 1,
                  "iat": now - 120, "nbf": now - 120, "exp": now + 3600}
        claims.update(changes or {})
        for claim in remove:
            claims.pop(claim, None)
        header = {"alg": "RS256", "typ": "at+jwt", "kid": "assurance"}
        message = ".".join(b64url(json.dumps(value, separators=(",", ":")).encode())
                           for value in (header, claims)).encode()
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(self.other_key if other_key else self.key)],
            input=message, check=True, capture_output=True, timeout=10).stdout
        return message.decode() + "." + b64url(signature)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def clean_environment(work, issuer, probe, disabled):
    environment = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(work), "DOTNET_CLI_HOME": str(work), "TMPDIR": str(work),
        "AZURE_CONFIG_DIR": str(work / "azure"), "DOTNET_NOLOGO": "1",
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1", "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated",
        "AzureWebJobsStorage": "UseDevelopmentStorage=true", "AzureWebJobsSecretStorageType": "Files",
        "FUNCTIONS_OAUTH_MODE": "enforced", "FUNCTIONS_JWT_ISSUER": issuer.rstrip("/"),
        "FUNCTIONS_JWT_AUDIENCE": issuer + "functions",
        "IDENTITY_ENDPOINT": issuer + "identity", "IDENTITY_HEADER": "isolated-test",
        "SQL_CONNECTION_STRING": "Server=127.0.0.1,1;Database=offline;Connect Timeout=1;Encrypt=false",
        "AI_FOUNDRY_PROJECT_ENDPOINT": issuer, "AI_AGENT_CHAT_ID": "isolated-chat",
        "MCP_SERVICE_URL": issuer + "mcp", "AUTH_ASSURANCE_HOST_PROBE": str(probe),
    }
    for name in disabled:
        environment[f"AzureWebJobs.{name}.Disabled"] = "true"
    return environment


def stop_process(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_for_storage(process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HostFailure("The local storage emulator exited during startup")
        try:
            with socket.create_connection(("127.0.0.1", 10000), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise HostFailure("The local storage emulator did not start within 30 seconds")


def probe_events(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def request(port, method, route, token=None, body=None, timeout=15):
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else (b"{}" if method in {"POST", "PUT", "PATCH"} else None)
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/{route}", method=method,
                                 headers=headers, data=data)
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(4096)
        try:
            document = json.loads(raw) if raw else {}
        except (ValueError, UnicodeDecodeError):
            document = {"unexpectedNonJsonBody": True}
        return response.status, response.headers, document


def assert_call(probe, port, function, method, route, status, error, token=None,
                body=None, handler=False, scope=None, issuer=None):
    before = len(probe_events(probe))
    actual, headers, document = request(port, method, route, token, body)
    events = probe_events(probe)[before:]
    phases = ["host", "handler"] if handler else ["host"]
    if (len(events) != len(phases) or
            [event.get("phase") for event in events] != phases or
            any(event.get("function") != function for event in events) or
            len({event.get("invocation") for event in events}) != 1):
        raise HostFailure(f"{function} {method}: unexpected handler or host invocation")
    if actual != status or (error is not None and document.get("error") != error):
        raise HostFailure(f"{function} {method}: expected HTTP {status}/{error}, observed HTTP {actual}")
    if status in {401, 403} and issuer:
        challenge = headers.get("WWW-Authenticate", "")
        required = ["Bearer ", f'error="{error}"',
                    f'resource_metadata="{issuer}.well-known/oauth-protected-resource"']
        if scope:
            required.append(f'scope="{scope}"')
        if not challenge.startswith(required[0]) or any(item not in challenge for item in required[1:]):
            raise HostFailure(f"{function} {method}: incorrect authentication challenge")


def assert_unsupported_method(probe, port, function, method, route):
    before = len(probe_events(probe))
    status, _, body = request(port, method, route)
    if status not in {200, 204, 404, 405} or body or len(probe_events(probe)) != before:
        raise HostFailure(f"{function} {method}: unsupported method reached a handler or returned data")


def assert_reset_dependencies_fail_closed(probe, port, issuer):
    before = len(probe_events(probe))
    identities_before = issuer.identity_requests
    status, _, body = request(port, "POST", "simulators/reset",
                              issuer.token(scope="admin.write"), timeout=90)
    events = probe_events(probe)[before:]
    if (len(events) != 2 or [event.get("phase") for event in events] != ["host", "handler"] or
            any(event.get("function") != "SimulatorsReset" for event in events) or
            events[0].get("invocation") != events[1].get("invocation")):
        raise HostFailure("The isolated reset did not reach exactly one authorized handler")
    if (status != 500 or not isinstance(body, dict) or body.get("message") != "Simulator reset incomplete." or
            body.get("steps") != ["Manufacturing queue clear failed.", "Supply chain reset failed.",
                                  "Bank reset failed.", "Shopping simulator reset failed."] or
            not isinstance(body.get("resetAtUtc"), str) or
            issuer.identity_requests - identities_before < 3):
        raise HostFailure(f"Blocked simulator reset did not return a sanitized failure (HTTP {status})")


def isolated_run(inventory, metadata, app, work, func, azurite, output):
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=10)
    links = json.loads(subprocess.run(["ip", "-j", "link"], check=True, capture_output=True,
                                      text=True, timeout=10).stdout)
    routes = json.loads(subprocess.run(["ip", "-j", "route"], check=True, capture_output=True,
                                       text=True, timeout=10).stdout)
    if {item.get("ifname") for item in links} != {"lo"} or routes:
        raise HostFailure("The Functions host network is not loopback-only")
    disabled = verify_metadata(inventory, metadata)
    issuer = LocalIssuer(work)
    probe = work / "probe.jsonl"
    environment = clean_environment(work, issuer.issuer, probe, disabled)
    cases = []
    storage = host = None
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with (work / "azurite.log").open("w+") as storage_log, (work / "host.log").open("w+") as host_log:
            storage = subprocess.Popen(
                [str(azurite), "--silent", "--location", str(work / "storage"),
                 "--blobHost", "127.0.0.1", "--queueHost", "127.0.0.1", "--tableHost", "127.0.0.1"],
                cwd=work, env=environment, stdout=storage_log, stderr=subprocess.STDOUT)
            wait_for_storage(storage)
            host = subprocess.Popen([str(func), "host", "start", "--port", str(port), "--no-build"],
                                    cwd=app, env=environment, stdout=host_log, stderr=subprocess.STDOUT)
            for attempt in range(120):
                if host.poll() is not None:
                    raise HostFailure("The isolated Functions host exited during startup")
                try:
                    status, _, _ = request(port, "GET", "health")
                    if status == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(1)
            else:
                raise HostFailure("The isolated Functions host did not become ready")
            events = probe_events(probe)
            if (len(events) != 2 or [event.get("phase") for event in events] != ["host", "handler"] or
                    any(event.get("function") != "HealthCheck" for event in events) or
                    events[0].get("invocation") != events[1].get("invocation")):
                raise HostFailure("The public health positive control or probe ordering failed")
            host_log.flush()
            startup = (work / "host.log").read_text()
            missing = [name for name in disabled
                       if f"Function {name} is disabled." not in startup and
                       f"Function 'Functions.{name}' is disabled" not in startup]
            if missing:
                raise HostFailure("Non-HTTP triggers were not confirmed disabled: " + ", ".join(missing))
            cases.append(CONTROLS[0])

            assert_call(probe, port, UNCLASSIFIED, "GET", "__auth-assurance/unclassified",
                        403, "unclassified_function")
            cases.append(CONTROLS[1])
            valid = issuer.token(scope="realtime.connect")
            assert_call(probe, port, "NegotiateWebPubSub", "GET", "webpubsub/negotiate",
                        503, "Web PubSub is not configured.", valid, handler=True)
            cases.append(CONTROLS[2])
            for control, changes in [(CONTROLS[3], {"exp": int(time.time()) - 25}),
                                     (CONTROLS[4], {"nbf": int(time.time()) + 25})]:
                token = issuer.token(scope="realtime.connect", changes=changes)
                assert_call(probe, port, "NegotiateWebPubSub", "GET", "webpubsub/negotiate",
                            503, "Web PubSub is not configured.", token, handler=True)
                cases.append(control)
            assert_call(probe, port, "OwnedCartItems", "GET", "cart/items",
                        401, "invalid_guest_session", handler=True)
            cases.append(CONTROLS[5])
            assert_call(probe, port, "AIAgentChat", "POST", "agent/chat", 401,
                        "Sign in again to use the AI assistant.", body={"message": "test"}, handler=True)
            cases.append(CONTROLS[6])
            assert_reset_dependencies_fail_closed(probe, port, issuer)
            cases.append(CONTROLS[7])

            surfaces = function_surface_inventory(inventory)
            for name, method, route, needs_identity in DESTRUCTIVE_CONTROLS:
                matches = [item for item in surfaces if item["kind"] == "http" and
                           item["name"] == name and item["method"] == method and
                           item["route"] == route]
                if len(matches) != 1 or matches[0]["policy"].get("Mode") != "InternalOnly":
                    raise HostFailure(f"Destructive control {name} no longer matches the reviewed policy")
                scope = matches[0]["policy"].get("RequiredScope")
                if not isinstance(scope, str) or not scope:
                    raise HostFailure(f"Destructive control {name} has no scope")
                identities_before = issuer.identity_requests
                assert_call(probe, port, name, method, route, 500, None,
                            issuer.token(scope=scope), handler=True)
                if needs_identity and issuer.identity_requests == identities_before:
                    raise HostFailure(f"Destructive control {name} did not reach the blocked dependency")
                cases.append("host:control:blocked-" + name)

            now = int(time.time())
            tokens = {
                "missing-token": None,
                "malformed-token": "not-a-jwt",
                "wrong-signature": issuer.token(other_key=True),
                "wrong-issuer": issuer.token(changes={"iss": issuer.issuer + "wrong"}),
                "dab-audience": issuer.token(changes={"aud": issuer.issuer + "dab"}),
                "mcp-audience": issuer.token(changes={"aud": issuer.issuer + "mcp"}),
                "expired": issuer.token(changes={"exp": now - 3600}),
                "not-before": issuer.token(changes={"nbf": now + 3600}),
                "missing-expiration": issuer.token(remove=("exp",)),
                "missing-subject": issuer.token(remove=("sub",)),
                "missing-category": issuer.token(remove=("category",)),
                "unknown-category": issuer.token(category="unknown"),
                "insufficient-scope": issuer.token(),
            }
            consumers = {}
            declared = {(item["route"].strip("/").lower(), item["method"])
                        for item in surfaces if item["kind"] == "http"}
            for surface in surfaces:
                policy = surface.get("policy", {})
                if surface["kind"] != "http" or policy.get("IsAnonymous"):
                    continue
                scope = policy.get("RequiredScope")
                if not isinstance(scope, str) or not scope:
                    raise HostFailure("A protected route has no explicit scope")
                for scenario in DENIALS + (("consumer-category",) if policy["Mode"] == "InternalOnly" else ()):
                    if scenario == "consumer-category":
                        if scope not in consumers:
                            consumers[scope] = issuer.token(scope=scope, category="consumer")
                        token, status, error = consumers[scope], 403, "forbidden_category"
                    else:
                        token = tokens[scenario]
                        status = 403 if scenario == "insufficient-scope" else 401
                        error = ("insufficient_scope" if status == 403 else
                                 "missing_token" if scenario == "missing-token" else "invalid_token")
                    try:
                        assert_call(probe, port, surface["name"], surface["method"], route_path(surface["route"]),
                                    status, error, token, scope=scope if status == 403 else None,
                                    issuer=issuer.issuer)
                    except HostFailure as failure:
                        raise HostFailure(f"{scenario}: {failure}") from failure
                    cases.append(surface["id"] + ":" + scenario)
                for method in ALTERNATE_METHODS:
                    if (surface["route"].strip("/").lower(), method) not in declared:
                        assert_unsupported_method(probe, port, surface["name"], method,
                                                  route_path(surface["route"]))
                        cases.append(surface["id"] + ":unsupported-" + method)
            if set(cases) != set(expected_case_ids(inventory)) or len(cases) != len(set(cases)):
                raise HostFailure("Functions host results do not exactly cover the current inventory")
            events = probe_events(probe)
            dispatched = sum(not case.endswith((":unsupported-HEAD", ":unsupported-OPTIONS")) for case in cases)
            if len(events) != dispatched + 7 + len(DESTRUCTIVE_CONTROLS) or \
                    any(event.get("function") in disabled for event in events):
                raise HostFailure("Unexpected handler or disabled-trigger invocation was recorded")
            output.write_text(json.dumps({
                "schemaVersion": 1, "complete": True, "inventorySha256": inventory_digest(inventory),
                "workerSha256": hashlib.sha256((app / "api-functions.dll").read_bytes()).hexdigest(),
                "network": "loopback-only", "disabledNonHttpFunctions": disabled,
                "cases": [{"id": case, "status": "PASS"} for case in cases],
            }, indent=2) + "\n")
    finally:
        stop_process(host)
        stop_process(storage)
        issuer.close()


def linked_sources(project=None):
    """Repository-relative files the worker project compiles from outside api-functions/."""
    project = project or ROOT / "api-functions/api-functions.csproj"
    linked = []
    for element in ET.parse(project).getroot().iter():
        include = element.get("Include") if element.tag.rsplit("}", 1)[-1] == "Compile" else None
        if not include or not include.startswith(".."):
            continue
        path = (project.parent / include.replace("\\", "/")).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise HostFailure("A linked Functions source file is outside the repository or missing")
        linked.append(path.relative_to(ROOT).as_posix())
    return tuple(linked)


def prepare(inventory, output, func, azurite):
    function_surface_inventory(inventory)
    with tempfile.TemporaryDirectory(prefix="functions-auth-host-") as directory:
        work = Path(directory)
        source = work / "source"
        app = work / "app"
        shutil.copytree(ROOT / "api-functions", source / "api-functions",
                        ignore=shutil.ignore_patterns("bin", ".env*", "local.settings*.json", "TestResults"))
        for relative in ("global.json", *linked_sources()):
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        build = subprocess.run(
            ["dotnet", "build", str(source / "api-functions/api-functions.csproj"),
             "--no-restore", "-p:AuthAssuranceHost=true", "-o", str(app), "--verbosity", "quiet"],
            capture_output=True, text=True, timeout=240)
        if build.returncode:
            raise HostFailure("The isolated, instrumented Functions worker failed to build")
        metadata = json.loads((app / "functions.metadata").read_text())
        verify_metadata(inventory, metadata)
        inventory_file = work / "inventory.json"
        inventory_file.write_text(json.dumps(inventory))
        inner = subprocess.run(
            ["unshare", "--user", "--map-root-user", "--net", sys.executable, "-B", __file__,
             "--inner", "--inventory", str(inventory_file), "--app", str(app), "--work", str(work),
             "--func", str(func), "--azurite", str(azurite), "--output", str(output)],
            capture_output=True, text=True, timeout=1200)
        if inner.returncode:
            detail = inner.stderr.strip().splitlines()[-1:] or inner.stdout.strip().splitlines()[-1:]
            raise HostFailure("Isolated Functions host failed: " + (detail[0] if detail else "unknown error"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True, help="Current reflected Functions inventory")
    parser.add_argument("--output", type=Path, required=True, help="New sanitized result JSON")
    parser.add_argument("--func", default=shutil.which("func"), help="Functions Core Tools executable")
    parser.add_argument("--azurite", default=shutil.which("azurite"), help="Azurite executable")
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--app", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--work", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.func or not args.azurite or any(not shutil.which(name) for name in ("dotnet", "openssl", "unshare", "ip")):
        print("Functions Core Tools, Azurite, dotnet, openssl, unshare and ip are required", file=sys.stderr)
        return 2
    if args.output.exists():
        print("Refusing to overwrite existing Functions host evidence", file=sys.stderr)
        return 2
    if not args.inner:
        try:
            isolation = subprocess.run(
                ["unshare", "--user", "--map-root-user", "--net", "ip", "link", "set", "lo", "up"],
                capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            isolation = None
        if isolation is None or isolation.returncode:
            print("A loopback-only network namespace is unavailable", file=sys.stderr)
            return 2
    try:
        inventory = json.loads(args.inventory.read_text())
        if args.inner:
            if args.app is None or args.work is None:
                raise HostFailure("The isolated host paths are missing")
            metadata = json.loads((args.app / "functions.metadata").read_text())
            isolated_run(inventory, metadata, args.app, args.work, Path(args.func), Path(args.azurite), args.output)
        else:
            prepare(inventory, args.output.resolve(), Path(args.func).resolve(), Path(args.azurite).resolve())
        return 0
    except (HostFailure, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Functions host assurance failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
