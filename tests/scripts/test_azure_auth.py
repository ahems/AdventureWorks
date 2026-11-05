"""Offline regression tests for scripts/utilities/azure-auth.py."""

import argparse
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("azure_auth", ROOT / "scripts/utilities/azure-auth.py")
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
BASE = "https://deployment.example"


def jwt(identity="manufacturing", resource="dab", **overrides):
    payload = {
        "iss": BASE + "/", "aud": BASE + "/" + resource,
        "sub": "test-subject", "roles": [auth.IDENTITIES[identity][4]],
    }
    payload.update(overrides)
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return "header." + encoded + ".signature"


def response(identity="manufacturing", resource="dab", **overrides):
    result = {"access_token": jwt(identity, resource), "token_type": "Bearer",
              "refresh_token": "replacement-refresh", "expires_in": 600}
    result.update(overrides)
    return json.dumps(result).encode()


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(command="token", identity="manufacturing", timeout=180)
        self.calls = []

    def fake_http(self, opener, url, timeout, **kwargs):
        self.calls.append((url, kwargs))
        if url.endswith("/login"):
            return 302, {"Location": "/"}, b""
        if url.endswith("/authorize"):
            form = kwargs["form"]
            location = form["redirect_uri"] + "?" + urllib.parse.urlencode({
                "code": "code +/=encoded", "state": form["state"],
            })
            return 302, {"Location": location}, b""
        return 200, {}, response(self.args.identity)

    def test_pkce_and_canned_identities(self):
        for identity in auth.IDENTITIES:
            with self.subTest(identity=identity):
                self.args.identity = identity
                self.calls = []
                with patch.object(auth, "send_http", side_effect=self.fake_http):
                    result = auth.session(Mock(), self.args, BASE, BASE + "/dab")
                login, authorize, exchange = [call[1]["form"] for call in self.calls]
                self.assertEqual(login["username"], auth.IDENTITIES[identity][0])
                self.assertEqual(authorize["client_id"], auth.IDENTITIES[identity][2])
                self.assertIn("offline_access", authorize["scope"])
                self.assertEqual(authorize["resource"], BASE + "/dab")
                verifier = exchange["code_verifier"]
                self.assertGreaterEqual(len(verifier), 43)
                self.assertLessEqual(len(verifier), 128)
                challenge = base64.urlsafe_b64encode(
                    hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                self.assertEqual(authorize["code_challenge"], challenge)
                self.assertEqual(authorize["code_challenge_method"], "S256")
                self.assertEqual(exchange["code"], "code +/=encoded")
                self.assertEqual(exchange["redirect_uri"], authorize["redirect_uri"])
                self.assertEqual(result["_client_id"], authorize["client_id"])

    def test_login_rejection_stops_flow(self):
        with patch.object(auth, "send_http", return_value=(302, {"Location": "/login?error=1"}, b"")) as send:
            with self.assertRaisesRegex(auth.AuthError, "Login failed"):
                auth.session(Mock(), self.args, BASE, BASE + "/dab")
            self.assertEqual(send.call_count, 1)

    def test_bad_callback_state_code_and_oauth_error(self):
        for callback, message in [
            ("https://other.example/?code=stolen", "registered callback"),
            ("http://localhost:5175/oauth/callback?code=x&state=bad", "state mismatch"),
            ("http://localhost:5175/oauth/callback?state=STATE", "missing authorization code"),
            ("http://localhost:5175/oauth/callback?state=STATE&error=access_denied", "Authorization denied"),
        ]:
            with self.subTest(callback=callback):
                def send(opener, url, timeout, **kwargs):
                    if url.endswith("/login"):
                        return 302, {"Location": "/"}, b""
                    state = kwargs["form"]["state"]
                    return 302, {"Location": callback.replace("STATE", state)}, b""
                with patch.object(auth, "send_http", side_effect=send):
                    with self.assertRaisesRegex(auth.AuthError, message):
                        auth.session(Mock(), self.args, BASE, BASE + "/dab")

    def test_issuer_audience_subject_and_role_binding(self):
        for override in [{"iss": "https://other.example/"}, {"aud": BASE + "/functions"},
                         {"sub": ""}, {"roles": ["executive-admin"]}]:
            with self.subTest(override=override):
                def send(opener, url, timeout, **kwargs):
                    if url.endswith("/token"):
                        return 200, {}, response(access_token=jwt(**override))
                    return self.fake_http(opener, url, timeout, **kwargs)
                with patch.object(auth, "send_http", side_effect=send):
                    with self.assertRaisesRegex(auth.AuthError, "does not match"):
                        auth.session(Mock(), self.args, BASE, BASE + "/dab")

    def test_refresh_rotation_and_resource_switch(self):
        self.args.command = "refresh"
        previous = {"_client_id": auth.IDENTITIES["manufacturing"][2],
                    "_issuer": BASE + "/", "refresh_token": "original-refresh"}
        with patch.object(auth.sys, "stdin", io.StringIO(json.dumps(previous))), \
                patch.object(auth, "send_http", return_value=(200, {}, response(resource="functions"))) as send:
            result = auth.session(Mock(), self.args, BASE, BASE + "/functions")
        form = send.call_args.kwargs["form"]
        self.assertEqual(form["refresh_token"], "original-refresh")
        self.assertEqual(form["resource"], BASE + "/functions")
        self.assertEqual(result["refresh_token"], "replacement-refresh")
        self.assertEqual(send.call_count, 1)

    def test_refresh_rejects_mismatched_or_missing_session(self):
        self.args.command = "refresh"
        for previous in [{}, {"_client_id": "other", "_issuer": BASE + "/"},
                         {"_client_id": auth.IDENTITIES["manufacturing"][2], "_issuer": BASE + "/"}]:
            with patch.object(auth.sys, "stdin", io.StringIO(json.dumps(previous))), \
                    patch.object(auth, "send_http") as send:
                with self.assertRaises(auth.AuthError):
                    auth.session(Mock(), self.args, BASE, BASE + "/dab")
                send.assert_not_called()

    def test_token_errors_never_dump_tokens(self):
        body = json.dumps({"error": "invalid_grant", "access_token": "SECRET",
                           "refresh_token": "SECRET"}).encode()
        with self.assertRaises(auth.AuthError) as error:
            auth.token_response(400, body)
        self.assertIn("invalid_grant", str(error.exception))
        self.assertNotIn("SECRET", str(error.exception))
        for body in [b"{}", b'{"access_token": 123}', b'{"access_token":"x","token_type":"MAC"}']:
            with self.assertRaises(auth.AuthError):
                auth.token_response(200, body)

    def test_missing_rotating_refresh_token_fails(self):
        def send(opener, url, timeout, **kwargs):
            if url.endswith("/token"):
                return 200, {}, response(refresh_token=None)
            return self.fake_http(opener, url, timeout, **kwargs)
        with patch.object(auth, "send_http", side_effect=send):
            with self.assertRaisesRegex(auth.AuthError, "missing the requested rotating refresh_token"):
                auth.session(Mock(), self.args, BASE, BASE + "/dab")


class DeploymentAndRequestTests(unittest.TestCase):
    def test_azd_invocation_is_nonsourcing_and_environment_specific(self):
        with patch.object(auth.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, BASE, "")) as run:
            self.assertEqual(auth.azd_value("API_URL", "test-env"), BASE)
        command = run.call_args.args[0]
        self.assertIn("--no-prompt", command)
        self.assertIn(str(ROOT), command)
        self.assertEqual(command[-2:], ["--environment", "test-env"])

    def test_missing_azd_value_is_explicit(self):
        with patch.object(auth.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "private")):
            with self.assertRaisesRegex(auth.AuthError, "Cannot read API_URL"):
                auth.azd_value("API_URL", None)

    def test_optional_override_only_defaults_when_key_is_missing(self):
        diagnostic = "ERROR: key not found in environment values: 'KEY'"
        for stdout, stderr in [(diagnostic, ""), ("", diagnostic)]:
            missing = subprocess.CompletedProcess([], 1, stdout, stderr)
            with patch.object(auth.subprocess, "run", return_value=missing):
                self.assertEqual(auth.azd_value("KEY", None, required=False), "")
        failed = subprocess.CompletedProcess([], 1, "", "ERROR: environment is unavailable")
        with patch.object(auth.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(auth.AuthError, "Cannot read KEY"):
                auth.azd_value("KEY", None, required=False)

    def test_resource_derivation_and_override(self):
        with patch.object(auth, "azd_value", side_effect=[BASE + "/mcp/", ""]):
            self.assertEqual(auth.deployment(None, "functions"), (BASE, BASE + "/functions"))
        with patch.object(auth, "azd_value", side_effect=[BASE + "/mcp", "urn:custom:dab"]):
            self.assertEqual(auth.deployment("test", "dab"), (BASE, "urn:custom:dab"))

    def test_path_and_https_guards(self):
        for path in ["https://other.example", "//other.example/path", "api/Product", "/path#fragment"]:
            with self.subTest(path=path), self.assertRaises(auth.AuthError):
                auth.request_url(BASE, path)
        self.assertEqual(auth.request_url(BASE, "/api/Product?$first=5"), BASE + "/api/Product?$first=5")
        for url in ["http://example.com", "https://user:password@example.com", "https://example.com/?q=x"]:
            with self.subTest(url=url), self.assertRaises(auth.AuthError):
                auth.https_url(url)

    def test_http_redirects_are_captured_not_followed(self):
        error = urllib.error.HTTPError(BASE, 302, "Found", {"Location": "https://other.example"}, io.BytesIO(b""))
        opener = Mock()
        opener.open.side_effect = error
        status, headers, _ = auth.send_http(opener, BASE, 180)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "https://other.example")
        self.assertIsNone(auth.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_network_failure_is_explicit(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError("timeout")
        with self.assertRaisesRegex(auth.AuthError, "Network request failed"):
            auth.send_http(opener, BASE + "/token", 180)

    def test_invalid_timeout_and_target_fail_before_login(self):
        for extra in [["--timeout", "nan"], ["--timeout", "0"], ["--timeout", "inf"]]:
            with patch.object(auth.sys, "argv", [
                "azure-auth.py", "token", "--identity", "admin", "--resource", "dab", *extra
            ]), patch.object(auth.sys, "stderr", io.StringIO()), patch.object(auth, "session") as login:
                with self.assertRaises(SystemExit):
                    auth.main()
                login.assert_not_called()
        with patch.object(auth.sys, "argv", [
            "azure-auth.py", "request", "--identity", "admin", "--resource", "dab",
            "--path", "//other.example"
        ]), patch.object(auth, "deployment", return_value=(BASE, BASE + "/dab")), \
                patch.object(auth, "azd_value", return_value=BASE + "/graphql"), \
                patch.object(auth, "session") as login:
            with self.assertRaises(auth.AuthError):
                auth.main()
            login.assert_not_called()

    def test_token_stdout_is_only_access_token_or_requested_json(self):
        for flags in [[], ["--json"]]:
            result = {"access_token": "SECRET", "refresh_token": "REFRESH"}
            output = io.StringIO()
            with patch.object(auth.sys, "argv", [
                "azure-auth.py", "token", "--identity", "admin", "--resource", "dab", *flags
            ]), patch.object(auth.sys, "stdout", output), \
                    patch.object(auth, "deployment", return_value=(BASE, BASE + "/dab")), \
                    patch.object(auth, "session", return_value=result):
                self.assertEqual(auth.main(), 0)
            if flags:
                self.assertEqual(json.loads(output.getvalue()), result)
            else:
                self.assertEqual(output.getvalue(), "SECRET\n")

    def test_request_headers_url_and_graphql_failure(self):
        for resource, path, status, body, fails in [
            ("dab", "/graphql", 200, b'{"data":{"products":{"items":[]}}}', False),
            ("dab", "/graphql", 200, b'{"errors":[{"message":"denied"}]}', True),
            ("functions", "/api/manufacturing/status", 403, b'{"error":"insufficient_scope"}', True),
            ("mcp", "/mcp", 200, b'{"jsonrpc":"2.0","result":{"tools":[]}}', False),
        ]:
            with self.subTest(resource=resource, status=status):
                argv = ["azure-auth.py", "request", "--identity", "manufacturing",
                        "--resource", resource, "--path", path]
                stdout = Mock()
                with patch.object(auth.sys, "argv", argv), patch.object(auth.sys, "stdout", stdout), \
                        patch.object(auth, "deployment", return_value=(BASE, BASE + "/" + resource)), \
                        patch.object(auth, "azd_value", return_value=BASE + "/graphql/"), \
                        patch.object(auth, "session", return_value={"access_token": "SECRET"}), \
                        patch.object(auth, "send_http", return_value=(status, {}, body)) as send:
                    if fails:
                        with self.assertRaises(auth.AuthError):
                            auth.main()
                    else:
                        self.assertEqual(auth.main(), 0)
                    stdout.buffer.write.assert_called_once_with(body)
                    headers = send.call_args.kwargs["headers"]
                    self.assertEqual(headers["Authorization"], "Bearer SECRET")
                    if resource == "dab":
                        self.assertEqual(headers["X-MS-API-ROLE"], "manufacturing-engineer")
                        self.assertEqual(send.call_args.args[1], BASE + "/graphql")
                    else:
                        self.assertNotIn("X-MS-API-ROLE", headers)
                    if resource == "mcp":
                        self.assertEqual(headers["Accept"], "application/json, text/event-stream")


if __name__ == "__main__":
    unittest.main()
