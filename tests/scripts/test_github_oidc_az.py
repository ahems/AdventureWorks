import base64
from concurrent.futures import ThreadPoolExecutor
import contextlib
import importlib.util
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock
from urllib import error, parse


ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "scripts/utilities/github-oidc-az.py"
SPEC = importlib.util.spec_from_file_location("github_oidc_az", WRAPPER)
oidc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oidc)


def assertion(expires):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": expires}).encode()).rstrip(b"=")
    return f"header.{payload.decode()}.signature"


class GitHubAssertionTests(unittest.TestCase):
    def setUp(self):
        self.environ = {
            "ACTIONS_ID_TOKEN_REQUEST_URL":
                "https://pipelines.actions.githubusercontent.com/job?id=1",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-request-token",
        }

    def response(self, body):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = body
        return response

    def test_requests_azure_audience_without_following_redirects(self):
        token = assertion(1300)
        opener = mock.Mock()
        opener.open.return_value = self.response(json.dumps({"value": token}).encode())
        with mock.patch.object(oidc.request, "build_opener", return_value=opener) as build:
            self.assertEqual(oidc.github_assertion(self.environ, 1000), (token, 1300))
        self.assertIsInstance(build.call_args.args[0], oidc.NoRedirect)
        sent = opener.open.call_args.args[0]
        self.assertEqual(parse.parse_qs(parse.urlsplit(sent.full_url).query), {
            "id": ["1"], "audience": [oidc.AUDIENCE],
        })
        self.assertEqual(sent.get_header("Authorization"), "Bearer synthetic-request-token")
        self.assertIsNone(oidc.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com"))

    def test_rejects_untrusted_urls_and_invalid_or_expiring_assertions(self):
        for url in (
            "http://pipelines.actions.githubusercontent.com/job",
            "https:///job",
            "https://user@pipelines.actions.githubusercontent.com/job",
            "https://pipelines.actions.githubusercontent.com/job?audience=other",
            "https://pipelines.actions.githubusercontent.com/job?AUDIENCE=",
            "https://pipelines.actions.githubusercontent.com/job#fragment",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(oidc.RenewalError, "invalid OIDC request URL"):
                oidc.github_assertion({**self.environ, "ACTIONS_ID_TOKEN_REQUEST_URL": url}, 1000)

        bodies = [
            b"not-json",
            b'{"value": 123}',
            b'{"value": "not-a-jwt"}',
            json.dumps({"value": assertion("invalid")}).encode(),
            json.dumps({"value": assertion(1089)}).encode(),
            b"x" * 65537,
        ]
        opener = mock.Mock()
        with mock.patch.object(oidc.request, "build_opener", return_value=opener):
            for body in bodies:
                opener.open.return_value = self.response(body)
                with self.subTest(body=body[:40]), self.assertRaises(oidc.RenewalError):
                    oidc.github_assertion(self.environ, 1000)

    def test_retries_transient_errors_and_does_not_expose_http_body(self):
        opener = mock.Mock()
        transient = error.HTTPError("https://example.invalid", 503, "failed", {}, None)
        opener.open.side_effect = [
            transient, self.response(json.dumps({"value": assertion(1300)}).encode()),
        ]
        with mock.patch.object(oidc.request, "build_opener", return_value=opener), \
                mock.patch.object(oidc.time, "sleep") as sleep:
            oidc.github_assertion(self.environ, 1000)
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(1)

        opener.open.side_effect = error.HTTPError(
            "https://example.invalid/synthetic-secret", 403, "synthetic-secret", {}, None
        )
        with mock.patch.object(oidc.request, "build_opener", return_value=opener):
            with self.assertRaises(oidc.RenewalError) as raised:
                oidc.github_assertion(self.environ, 1000)
        self.assertIn("HTTP 403", str(raised.exception))
        self.assertNotIn("synthetic-secret", str(raised.exception))


FAKE_AZ = r"""#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[1:]
profile = Path(os.environ["AZURE_CONFIG_DIR"])

def event(data):
    fd = os.open(os.environ["FAKE_AZ_LOG"], os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.write(fd, (json.dumps(data) + "\n").encode())
    finally:
        os.close(fd)

if args[0] == "login":
    client = args[args.index("--username") + 1]
    tenant = args[args.index("--tenant") + 1]
    subscription = args[args.index("--subscription") + 1]
    token = args[args.index("--federated-token") + 1]
    event({"kind": "login", "client": client, "tenant": tenant, "subscription": subscription,
           "cached_access_token": (profile / "msal_token_cache.json").exists(),
           "telemetry": os.environ.get("AZURE_CORE_COLLECT_TELEMETRY")})
    if os.environ.get("FAKE_AZ_FAIL_LOGIN"):
        print("AADSTS700024 sensitive login diagnostic " + token, file=sys.stderr)
        sys.exit(1)
    time.sleep(0.05)
    profile.mkdir(exist_ok=True)
    (profile / "azureProfile.json").write_text(json.dumps({"subscription": subscription}))
    (profile / "service_principal_entries.json").write_text(token)
    (profile / "msal_token_cache.json").write_text("{}")
    sys.exit(0)

account = json.loads((profile / "azureProfile.json").read_text())
token_before = (profile / "service_principal_entries.json").read_text()
event({"kind": "command", "args": args, "profile": str(profile),
       "subscription": account["subscription"],
       "telemetry": os.environ.get("AZURE_CORE_COLLECT_TELEMETRY")})
if args[0] == "hold":
    sync = Path(os.environ["FAKE_AZ_SYNC"])
    (sync / "started").write_text("started")
    deadline = time.monotonic() + 10
    while not (sync / "release").exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    if not (sync / "release").exists():
        sys.exit(7)
    if (profile / "service_principal_entries.json").read_text() != token_before:
        sys.exit(8)
elif args[0] == "echo":
    print(json.dumps({"args": args[1:], "subscription": account["subscription"]}))
elif args[0] == "fail":
    print("ordinary CLI failure", file=sys.stderr)
    sys.exit(23)
"""


class AzureCliRenewalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "adventureworks-az-oidc.test"
        self.state.mkdir(mode=0o700)
        self.fake_az = self.root / "real-az"
        self.fake_az.write_text(FAKE_AZ)
        self.fake_az.chmod(0o755)
        self.log = self.root / "events.jsonl"
        self.environ = {
            **os.environ,
            "GITHUB_ACTIONS": "true",
            "RUNNER_TEMP": str(self.root),
            "AW_GITHUB_AZ_CLI": str(self.fake_az),
            "AW_GITHUB_AZ_STATE": str(self.state),
            "AW_GITHUB_AZ_CLIENT_ID": "client-id",
            "AW_GITHUB_AZ_TENANT_ID": "tenant-id",
            "AW_GITHUB_AZ_SUBSCRIPTION_ID": "subscription-id",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/job",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-request-token",
            "FAKE_AZ_LOG": str(self.log),
            "FAKE_AZ_SYNC": str(self.root),
            "AZURE_CONFIG_DIR": str(self.root / "original-azure-profile"),
        }
        self.now = time.time()
        clock = mock.patch.object(oidc.time, "time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        acquire = mock.patch.object(
            oidc, "github_assertion",
            side_effect=lambda environ, now: (f"synthetic-assertion-{int(now)}", int(now) + 300),
        )
        self.acquire = acquire.start()
        self.addCleanup(acquire.stop)

    def events(self, kind):
        if not self.log.exists():
            return []
        return [
            item for item in map(json.loads, self.log.read_text().splitlines())
            if item["kind"] == kind
        ]

    def test_assertions_are_renewed_through_a_50_minute_deployment(self):
        for _ in range(51):
            self.assertEqual(oidc.run_az(["work"], self.environ), 0)
            self.now += 60
        logins = self.events("login")
        self.assertEqual(len(logins), 26)
        self.assertEqual(len(self.events("command")), 51)
        self.assertTrue(all(login["client"] == "client-id"
                            and login["tenant"] == "tenant-id"
                            and login["subscription"] == "subscription-id"
                            and not login["cached_access_token"]
                            and login["telemetry"] == "no"
                            for login in logins))
        self.assertTrue(all(command["telemetry"] == "no" for command in self.events("command")))
        self.assertFalse((self.root / "original-azure-profile").exists())

    def test_short_lived_assertions_are_renewed_before_expiry(self):
        self.acquire.side_effect = lambda environ, now: ("synthetic-assertion", int(now) + 100)
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        self.now += 9
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        self.assertEqual(len(self.events("login")), 1)
        self.now += 2
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        self.assertEqual(len(self.events("login")), 2)

    def test_parallel_calls_share_only_the_serialized_login(self):
        context = multiprocessing.get_context("fork")
        barrier = context.Barrier(8)
        queue = context.Queue()

        def worker():
            try:
                barrier.wait(timeout=5)
                queue.put(("ok", oidc.run_az(["work"], self.environ)))
            except Exception as exc:
                queue.put(("error", str(exc)))

        processes = [context.Process(target=worker) for _ in range(8)]
        for process in processes:
            process.start()
        try:
            results = [queue.get(timeout=10) for _ in processes]
        finally:
            for process in processes:
                process.join(timeout=10)
                if process.is_alive():
                    process.terminate()
                    process.join()
        self.assertEqual(results, [("ok", 0)] * 8)
        self.assertTrue(all(process.exitcode == 0 for process in processes))
        self.assertEqual(len(self.events("login")), 1)
        commands = self.events("command")
        self.assertEqual(len({command["profile"] for command in commands}), 8)
        self.assertTrue(all(not Path(command["profile"]).exists() for command in commands))

    def test_long_command_does_not_block_renewal_or_see_profile_changes(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            long_command = pool.submit(oidc.run_az, ["hold"], self.environ)
            deadline = time.monotonic() + 5
            while not (self.root / "started").exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.root / "started").exists())
            self.now += 180
            second = pool.submit(oidc.run_az, ["work"], self.environ)
            try:
                self.assertEqual(second.result(timeout=5), 0)
            finally:
                (self.root / "release").write_text("release")
            self.assertEqual(long_command.result(timeout=5), 0)
        self.assertEqual(len(self.events("login")), 2)

    def test_missing_oidc_and_failed_renewal_stop_without_leaking_assertion(self):
        missing = {**self.environ, "ACTIONS_ID_TOKEN_REQUEST_TOKEN": ""}
        with self.assertRaisesRegex(oidc.RenewalError, "OIDC permission"):
            oidc.run_az(["work"], missing)
        self.assertEqual(self.events("command"), [])

        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        self.now += 180
        self.acquire.return_value = ("synthetic-secret-assertion", int(self.now) + 300)
        self.acquire.side_effect = None
        failing = {**self.environ, "FAKE_AZ_FAIL_LOGIN": "1"}
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, failing, clear=True), contextlib.redirect_stderr(stderr):
            result = oidc.main(["work"])
        self.assertEqual(result, 1)
        self.assertIn("AADSTS700024", stderr.getvalue())
        self.assertNotIn("synthetic-secret-assertion", stderr.getvalue())
        self.assertEqual(len(self.events("command")), 1)
        self.assertFalse((self.state / "metadata.json").exists())
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        self.assertEqual(len(self.events("command")), 2)

    def test_login_timeout_is_sanitized_and_identity_changes_fail_closed(self):
        timeout = subprocess.TimeoutExpired(["az", "synthetic-secret"], 120)
        stderr = io.StringIO()
        with mock.patch.object(oidc.subprocess, "run", side_effect=timeout), \
                mock.patch.dict(os.environ, self.environ, clear=True), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(oidc.main(["work"]), 1)
        self.assertIn("renewal timed out", stderr.getvalue())
        self.assertNotIn("synthetic-secret", stderr.getvalue())

        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        with self.assertRaisesRegex(oidc.RenewalError, "renewal state is invalid"):
            oidc.run_az(["work"], {**self.environ, "AW_GITHUB_AZ_SUBSCRIPTION_ID": "other"})
        self.assertEqual(len(self.events("command")), 1)

    def test_path_wrapper_preserves_output_exit_status_and_shell_callers(self):
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        bin_dir = self.state / "bin"
        bin_dir.mkdir()
        (bin_dir / "az").symlink_to(WRAPPER)
        environ = {**self.environ, "PATH": f"{bin_dir}:{self.environ['PATH']}"}
        commands = [
            (["bash", "-c", "az echo 'from bash'"], "from bash"),
            (["python3", "-c", "import subprocess; subprocess.run(['az', 'echo', 'from-python'], check=True)"],
             "from-python"),
        ]
        if shutil.which("pwsh"):
            commands.append((
                ["pwsh", "-NoLogo", "-NoProfile", "-Command", "az echo from-pwsh; exit $LASTEXITCODE"],
                "from-pwsh",
            ))
        for command, expected in commands:
            result = subprocess.run(command, env=environ, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output["subscription"], "subscription-id")
            self.assertEqual(output["args"], [expected])
        failed = subprocess.run(["az", "fail"], env=environ, capture_output=True, text=True, timeout=10)
        self.assertEqual(failed.returncode, 23)
        self.assertIn("ordinary CLI failure", failed.stderr)
        self.assertEqual(len(self.events("login")), 1)

    def test_cleanup_restricts_removal_to_the_runner_session(self):
        outside = self.root / "unrelated"
        outside.mkdir()
        with self.assertRaisesRegex(oidc.RenewalError, "Refusing"):
            oidc.cleanup({**self.environ, "AW_GITHUB_AZ_STATE": str(outside)})
        link = self.root / "adventureworks-az-oidc.link"
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(oidc.RenewalError, "Refusing"):
            oidc.cleanup({**self.environ, "AW_GITHUB_AZ_STATE": str(link)})
        self.assertTrue(outside.exists())
        oidc.cleanup(self.environ)
        self.assertFalse(self.state.exists())
        self.assertTrue(outside.exists())

    @unittest.skipUnless(shutil.which("az"), "Azure CLI is not installed")
    def test_real_azure_cli_can_read_a_copied_profile(self):
        self.assertEqual(oidc.run_az(["work"], self.environ), 0)
        subscription = "dddddddd-dddd-dddd-dddd-dddddddddddd"
        (self.state / "profile/azureProfile.json").write_text(json.dumps({
            "subscriptions": [{
                "environmentName": "AzureCloud",
                "id": subscription,
                "isDefault": True,
                "name": "Synthetic subscription",
                "state": "Enabled",
                "tenantId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
                "user": {"name": "client-id", "type": "servicePrincipal"},
            }],
        }))
        bin_dir = self.state / "bin"
        bin_dir.mkdir()
        (bin_dir / "az").symlink_to(WRAPPER)
        environ = {
            **self.environ,
            "AW_GITHUB_AZ_CLI": shutil.which("az"),
            "PATH": f"{bin_dir}:{self.environ['PATH']}",
        }
        result = subprocess.run(
            ["az", "account", "show", "--query", "id", "--output", "tsv"],
            env=environ, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), subscription)

    def test_local_execution_without_github_configuration_is_rejected(self):
        with self.assertRaisesRegex(oidc.RenewalError, "not configured"):
            oidc.run_az(["work"], {**self.environ, "GITHUB_ACTIONS": ""})
        self.assertEqual(self.events("login"), [])

    def test_session_directory_must_be_private_and_inside_runner_temp(self):
        self.state.chmod(0o755)
        with self.assertRaisesRegex(oidc.RenewalError, "not private"):
            oidc.run_az(["work"], self.environ)
        self.state.chmod(0o700)
        with self.assertRaisesRegex(oidc.RenewalError, "unexpected"):
            oidc.run_az(["work"], {**self.environ, "RUNNER_TEMP": str(self.state)})
        self.assertEqual(self.events("login"), [])


if __name__ == "__main__":
    unittest.main()
