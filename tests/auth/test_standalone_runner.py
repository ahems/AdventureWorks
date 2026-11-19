import copy
import base64
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
import zlib
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


runner = module("standalone_runner", ROOT / "tests/scripts/run-auth-assurance-job.py")
reporting = module("standalone_reporting", ROOT / "tests/auth/reporting.py")
config = module("standalone_config", ROOT / "tests/auth/runtime_config.py")
entrypoint = module("standalone_entrypoint", ROOT / "tests/auth/container/entrypoint.py")


class StandaloneRunnerTests(unittest.TestCase):
    def test_key_vault_dns_check_requires_private_answers_for_the_selected_vault(self):
        configuration = {"values": {
            "MCP_SIGNING_KEY_VAULT_NAME": "demo-vault",
            "MCP_SIGNING_KEY_VAULT_URI": "https://demo-vault.vault.azure.net/",
        }}
        for addresses, expected in [
                (["10.42.3.8"], "PASS"),
                (["10.42.3.8", "8.8.8.8"], "FAIL"),
                (["203.0.113.10"], "FAIL"),
                (["::1"], "FAIL"),
                ([], "BLOCKED")]:
            with self.subTest(addresses=addresses), \
                    patch.object(entrypoint.socket, "getaddrinfo", return_value=[
                        (None, None, None, None, (address, 443)) for address in addresses]) as lookup:
                check = entrypoint.key_vault_dns_check(configuration)
                self.assertEqual(check["status"], expected)
                lookup.assert_called_once_with("demo-vault.vault.azure.net", 443)
        with patch.object(entrypoint.socket, "getaddrinfo", side_effect=entrypoint.socket.gaierror):
            self.assertEqual(entrypoint.key_vault_dns_check(configuration)["status"], "BLOCKED")
        for bad_uri in ["https://other.vault.azure.net/", "https://demo-vault.vault.azure.net/path",
                        "http://demo-vault.vault.azure.net/", "https://user@demo-vault.vault.azure.net/"]:
            with self.subTest(uri=bad_uri), patch.object(entrypoint.socket, "getaddrinfo") as lookup:
                bad = {"values": {**configuration["values"], "MCP_SIGNING_KEY_VAULT_URI": bad_uri}}
                self.assertEqual(entrypoint.key_vault_dns_check(bad)["status"], "BLOCKED")
                lookup.assert_not_called()
        self.assertEqual(entrypoint.key_vault_dns_check({})["status"], "BLOCKED")

    def test_workload_probe_runs_only_in_full_private_profile(self):
        for mode in [None, "browserOnly", "sqlOnly", "addressOnly", "mutations"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                configuration = {"sql": {"host": "sql.example.invalid"}}
                if mode:
                    configuration[mode] = True
                calls = []

                def execute(arguments, timeout, output):
                    output.write_text('{"checks":[]}\n')
                    return 0

                probe_module = SimpleNamespace(workload_checks=lambda cfg:
                    calls.append(cfg) or {"checks": [{"id": "test", "status": "BLOCKED"}]})
                with patch.object(entrypoint.socket, "getaddrinfo",
                                  return_value=[(None, None, None, None, ("10.0.0.1", 1433))]), \
                        patch.object(entrypoint, "execute", side_effect=execute), \
                        patch.dict("sys.modules", {"workload_probe": probe_module}):
                    documents = entrypoint.private_checks(configuration, Path(directory))
                self.assertEqual(len(calls), 1 if mode is None else 0)
                self.assertEqual("private-mcp-workload" in {label for label, _ in documents}, mode is None)

    def test_host_mutation_gate_requires_complete_unique_same_run_evidence(self):
        names = {
            "SetPassword:POST": "password-set",
            "VerifyPassword:POST": "password-verify",
            "UpdateAddress:PUT": "address-update",
            "SetAddressType:PUT": "address-type",
            "DeleteAddress:DELETE": "address-delete",
            "CreateAddress:POST": "address-create",
            "CreateCategory:POST": "category-create",
            "CreateSubcategory:POST": "subcategory-create",
        }
        def blocked(operation):
            return {"id": "functions:" + operation + ":deny", "group": "live-denials", "status": "BLOCKED",
                    "detail": "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears"}
        def evidence(label):
            result = [{"id": f"mutation:host-denial-{label}-{owner}-{credential}{suffix}",
                     "group": "mutations" if suffix else "live-denials", "status": "PASS"}
                    for owner in ["A", "B"] for credential in ["anonymous", "forged", "dab-audience"]
                    for suffix in ["", "-unchanged"]]
            if label == "address-create":
                result += [{"id": f"mutation:host-denial-{label}-{owner}-{credential}-baseline",
                            "group": "mutations", "status": "PASS"}
                           for owner in ["A", "B"] for credential in ["anonymous", "forged", "dab-audience"]]
                result.append({"id": "mutation:address-create-marker-control", "group": "mutations", "status": "PASS"})
            if label in {"category-create", "subcategory-create"}:
                result += [{"id": f"mutation:host-denial-{label}-{owner}-{credential}{suffix}",
                            "group": "mutations" if suffix else "live-denials", "status": "PASS"}
                           for owner in ["A", "B"] for credential in ["anonymous", "forged", "dab-audience"]
                           for suffix in ["-baseline"]]
                result += [{"id": f"mutation:host-denial-{label}-{owner}-consumer{suffix}",
                            "group": "mutations" if suffix else "live-denials", "status": "PASS"}
                           for owner in ["A", "B"] for suffix in ["", "-baseline", "-unchanged"]]
                result += [{"id": f"mutation:{label}-marker-control", "group": "mutations", "status": "PASS"}]
                result += [{"id": f"mutation:host-dab-token-control-{owner}", "group": "mutations", "status": "PASS"}
                           for owner in ["A", "B"]]
            return result

        for operation, label in names.items():
            with self.subTest(operation=operation):
                check = blocked(operation)
                entrypoint.reconcile_host_mutation_denials({"checks": [check]}, {"checks": evidence(label)}, 0)
                self.assertEqual(check["status"], "PASS")
                self.assertIn("run-owned", check["detail"])
                baseline = evidence(label)
                bad_status = copy.deepcopy(baseline)
                bad_status[0]["status"] = "FAIL"
                bad_group = copy.deepcopy(baseline)
                bad_group[0]["group"] = "mutations"
                for data, exit_code in [(baseline[:-1], 0), (baseline + baseline[:1], 0),
                                        (bad_status, 0), (bad_group, 0), (baseline, 1), (baseline, 2)]:
                    check = blocked(operation)
                    entrypoint.reconcile_host_mutation_denials({"checks": [check]}, {"checks": data}, exit_code)
                    self.assertEqual(check["status"], "BLOCKED")
                check = blocked(operation)
                check["status"] = "FAIL"
                entrypoint.reconcile_host_mutation_denials({"checks": [check]}, {"checks": baseline}, 0)
                self.assertEqual(check["status"], "FAIL")

    def test_local_unit_gate_is_only_reconciled_with_exact_private_pass(self):
        names = [
            "required:entra-assertion-real-signature-negatives",
            "required:functions-worker-middleware",
            "required:address-handler-ownership",
            "required:password-handler-ownership",
            "required:receipt-handler-ownership",
            "required:consumer-handlers-offline",
            "required:guest-cart-service-lifecycle",
            "required:mcp-tool-http-dispatch",
            "required:mcp-task-ownership-offline",
        ]
        def check(name, status, detail="No local tests. Evidence SHA256: {}"):
            return {"id": name, "group": "required", "status": status, "detail": detail}

        for name in names:
            with self.subTest(name=name):
                local = {"checks": [check(name, "BLOCKED")]}
                entrypoint.reconcile_unit_evidence(local, {"checks": [check(name, "PASS")]})
                self.assertEqual(local["checks"][0]["status"], "NOT_APPLICABLE")
                self.assertIn("private suite passed", local["checks"][0]["detail"])

        for local_check, suite_checks in [
            (check(names[0], "FAIL"), [check(names[0], "PASS")]),
            (check(names[0], "BLOCKED"), [check(names[0], "FAIL")]),
            (check(names[0], "BLOCKED"), []),
            (check(names[0], "BLOCKED"), [check(names[0], "PASS"), check(names[0], "PASS")]),
            (check(names[0], "BLOCKED", "Other blocker"), [check(names[0], "PASS")]),
            (check("required:other", "BLOCKED"), [check("required:other", "PASS")]),
        ]:
            with self.subTest(local=local_check, suite=suite_checks):
                original = copy.deepcopy(local_check)
                entrypoint.reconcile_unit_evidence({"checks": [local_check]}, {"checks": suite_checks})
                self.assertEqual(local_check, original)

    def test_mutation_profile_still_requires_private_sql_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def execute(arguments, timeout, output):
                self.assertEqual(arguments[:2], ["dotnet", "run"])
                output.write_text(json.dumps({"checks": [
                    {"id": "shared-uami", "status": "PASS", "detail": "Token identity matched."}]}))
                return 0
            with patch.object(entrypoint, "execute", side_effect=execute) as probe, \
                    patch.object(entrypoint.socket, "getaddrinfo", return_value=[
                        (None, None, None, None, ("10.0.0.5", 1433))]):
                documents = entrypoint.private_checks({"mutations": True, "sql": {"host": "sql.example.invalid"}}, root)
            probe.assert_called_once()
            self.assertEqual(documents[0][1]["checks"][0]["status"], "PASS")
            self.assertEqual(documents[1][1]["checks"][0]["id"], "effective-permissions-incomplete")
            self.assertEqual(documents[1][1]["checks"][0]["status"], "BLOCKED")

    def test_private_host_gate_uses_local_evidence_without_hiding_failed_or_unconfirmed_attempts(self):
        host_id = "required:functions-middleware-host-denials"
        def check(status, detail="Required coverage obligation is not established by registry or helper tests"):
            return {"id": host_id, "group": "required", "status": status, "detail": detail}

        for scenario in ["pass", "local-fail", "local-blocked", "private-fail", "private-attempt-blocked",
                         "missing-local", "duplicate-local", "duplicate-private", "wrong-group"]:
            with self.subTest(scenario=scenario):
                local = {"checks": [check("PASS", "Exact current-run isolated cases passed.")]}
                suite = {"checks": [check("BLOCKED")]}
                if scenario == "local-fail":
                    local["checks"][0]["status"] = "FAIL"
                elif scenario == "local-blocked":
                    local["checks"][0]["status"] = "BLOCKED"
                elif scenario == "private-fail":
                    suite["checks"][0]["status"] = "FAIL"
                elif scenario == "private-attempt-blocked":
                    suite["checks"][0]["detail"] = "The attempted host could not establish namespace isolation."
                elif scenario == "missing-local":
                    local["checks"] = []
                elif scenario == "duplicate-local":
                    local["checks"] *= 2
                elif scenario == "duplicate-private":
                    suite["checks"] *= 2
                elif scenario == "wrong-group":
                    local["checks"][0]["group"] = "offline"
                original = copy.deepcopy(suite)
                entrypoint.reconcile_unit_evidence(local, suite)
                if scenario == "pass":
                    self.assertEqual(suite["checks"][0]["status"], "NOT_APPLICABLE")
                    self.assertEqual(local["checks"][0]["status"], "PASS")
                else:
                    self.assertEqual(suite, original)

    def test_browser_only_dispatch_does_not_run_dotnet_or_sql_probes(self):
        with patch.object(entrypoint, "execute") as execute, \
                patch.object(entrypoint.socket, "getaddrinfo") as dns:
            self.assertEqual(entrypoint.private_checks({"browserOnly": True}, Path("/unused")), [])
        execute.assert_not_called()
        dns.assert_not_called()
        self.assertEqual(entrypoint.suite_arguments({"browserOnly": True}),
                         ["tests/auth/validate.py", "--browsers"])
        self.assertEqual(entrypoint.suite_arguments({"addressOnly": True}),
                         ["tests/auth/address_fixture_suite.py"])
        self.assertEqual(entrypoint.suite_arguments({}), ["tests/auth/validate.py", "--all"])
        self.assertEqual(entrypoint.suite_arguments({"sqlOnly": True}), [])
        self.assertEqual(entrypoint.suite_arguments({"mutations": True}), ["tests/auth/mutation_suite.py"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origins = {
                "APP_URL": "https://store.example.test",
                "APP_ADMIN_URL": "https://admin.example.test",
                "APP_MANUFACTURING_URL": "https://manufacturing.example.test",
                "MCP_INSPECTOR_URL": "https://inspector.example.test",
                "API_URL": "https://dab.example.test/graphql/",
                "API_FUNCTIONS_URL": "https://functions.example.test/api/",
                "API_MCP_URL": "https://mcp.example.test/mcp",
            }
            deployment = SimpleNamespace(
                runtime=None,
                values={"AZURE_ENV_NAME": "selected"},
                required=lambda key: origins[key],
            )
            with patch.object(runner.auth, "command", return_value=""), \
                    patch.object(runner.auth, "Deployment", return_value=deployment), \
                    patch.object(runner.auth, "browser_tests") as browsers, \
                    patch.object(runner.auth, "export_inventory") as inventory, \
                    patch.object(runner.auth, "offline_tests") as offline, \
                    patch.object(runner.auth, "infra") as infra, patch("builtins.print"):
                self.assertEqual(runner.auth.main(["--browsers", "--output", str(root / "report")]), 0)
            browsers.assert_called_once()
            inventory.assert_not_called()
            offline.assert_not_called()
            infra.assert_not_called()
            report = json.loads((root / "report" / "report.json").read_text())
            self.assertEqual(len(report["inventory"]["deploymentOrigins"]), 7)

    def test_address_profile_reports_interrupted_or_inconsistent_cleanup_as_failure(self):
        def document(status, outcome=None):
            return {"outcome": outcome or status, "checks": [{
                "id": "address-result", "group": "ownership", "status": status, "detail": "Fixture result.",
            }], "inventory": {}}

        cases = [
            ("pass", 0, document("PASS"), False),
            ("blocked-before-writes", 2, document("BLOCKED"), False),
            ("actual-failure", 1, document("FAIL"), True),
            ("missing", 2, None, True),
            ("malformed", 2, "{", True),
            ("exit-disagrees", 0, document("BLOCKED"), True),
            ("outcome-disagrees", 0, document("PASS", "BLOCKED"), True),
            ("interrupted", 124, None, True),
            ("duplicate", 0, {**document("PASS"), "checks": document("PASS")["checks"] * 2}, True),
            ("invalid-residual-inventory", 0, {**document("PASS"), "inventory": {
                "addressFixtureResiduals": [{"password": "must not be published"}]}}, True),
        ]
        for label, exit_code, report, failed in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                documents = []

                def execute(arguments, timeout, output):
                    target = Path(arguments[arguments.index("--output") + 1])
                    target.mkdir()
                    if report is not None:
                        (target / "report.json").write_text(report if isinstance(report, str) else json.dumps(report))
                    return exit_code

                with patch.object(entrypoint, "private_checks", return_value=[]), \
                        patch.object(entrypoint, "execute", side_effect=execute):
                    entrypoint.run_profile({"addressOnly": True}, root, documents)
                checks = [check for _, result in documents for check in result["checks"]]
                self.assertEqual(any(check["status"] == "FAIL" for check in checks), failed)
                if label in {"missing", "malformed", "exit-disagrees", "outcome-disagrees", "interrupted",
                             "duplicate", "invalid-residual-inventory"}:
                    self.assertTrue(any("cleanup" in check["detail"] for check in checks))

    def test_address_residual_inventory_is_run_bound_and_excludes_unexpected_fields(self):
        run_id = "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21"
        marker = "AuthAssurance-8b2bc931cd544f4f8963acde3143ad21"
        pending = {"kind": "address-fixture", "owner": 7, "marker": marker, "state": "creation-requested"}
        created = {**pending, "id": 101, "state": "created"}
        link = {**created, "kind": "address-fixture-link", "state": "deleted"}
        self.assertTrue(entrypoint.valid_address_inventory({}, run_id))
        self.assertTrue(entrypoint.valid_address_inventory({"addressFixtureResiduals": [pending, created, link]}, run_id))
        invalid = [
            None, {"addressFixtureResiduals": {}},
            {"addressFixtureResiduals": [{**created, "password": "not for reports"}]},
            {"addressFixtureResiduals": [{**created, "marker": "other-run"}]},
            {"addressFixtureResiduals": [{**created, "owner": True}]},
            {"addressFixtureResiduals": [{**created, "id": -1}]},
            {"addressFixtureResiduals": [{**created, "state": "unknown"}]},
            {"addressFixtureResiduals": [{**created, "kind": []}]},
            {"addressFixtureResiduals": [{**created, "state": {}}]},
            {"addressFixtureResiduals": [{**pending, "state": "deleted"}]},
            {"addressFixtureResiduals": [{**pending, "kind": "address-fixture-link"}]},
        ]
        for inventory in invalid:
            with self.subTest(inventory=inventory):
                self.assertFalse(entrypoint.valid_address_inventory(inventory, run_id))
        self.assertFalse(entrypoint.valid_address_inventory({"addressFixtureResiduals": [created]}, "other-run"))

    def test_published_address_report_retains_residuals_when_table_snapshot_is_unavailable(self):
        run_id = "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21"
        residuals = [{"kind": "address-fixture", "owner": 7, "id": 101,
                      "marker": "AuthAssurance-fixture", "state": "created"}]
        configuration = {
            "runId": run_id, "addressOnly": True, "values": {"AZURE_ENV_NAME": "selected"},
            "identity": {"clientId": "client"}, "storage": {"prefix": "auth-assurance/" + run_id + "/"},
            "sourceRevision": "revision", "sourceSha256": "source", "imageDigest": "digest",
            "localReport": {"checks": [{"id": "scope", "group": "scope", "status": "PASS", "detail": "Scoped."}]},
        }
        encoded = base64.b64encode(zlib.compress(json.dumps(configuration).encode())).decode()
        identity = ModuleType("azure.identity")
        credential = SimpleNamespace(close=lambda: None)
        identity.ManagedIdentityCredential = lambda **_: credential
        azure = ModuleType("azure")
        azure.__path__ = []
        published = []

        def profile(configuration, root, documents):
            documents.append(("suite", {"checks": [{
                "id": "address-fixtures:cleanup-unverified", "group": "ownership",
                "status": "FAIL", "detail": "Cleanup unavailable.",
            }], "inventory": {"addressFixtureResiduals": residuals}}))

        def storage(configuration, credential, run_checks):
            run_checks()
            return {"checks": [{
                "id": "table", "group": "private", "status": "BLOCKED", "detail": "Snapshot unavailable.",
            }], "mutationLedger": []}

        def upload(configuration, directory, credential):
            published.append(json.loads((directory / "report.json").read_text()))
            return {}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "assurance"
            with patch.dict(os.environ, {"AUTH_ASSURANCE_CONFIG_B64": encoded}), \
                    patch.dict(sys.modules, {"azure": azure, "azure.identity": identity}), \
                    patch.object(entrypoint, "Path", side_effect=lambda value: root if value == "/tmp/assurance" else Path(value)), \
                    patch.object(entrypoint.runtime_config, "load"), \
                    patch.object(entrypoint, "run_profile", side_effect=profile), \
                    patch.object(entrypoint, "temporary_storage_check", side_effect=storage), \
                    patch.object(entrypoint, "pdf"), patch.object(entrypoint, "upload", side_effect=upload), \
                    patch("builtins.print"):
                self.assertEqual(entrypoint.run(), 1)
        self.assertEqual(published[0]["provenance"]["addressFixtureResiduals"], residuals)
        self.assertNotIn("mutationLedger", published[0]["provenance"])

    def test_browser_profile_runs_every_site_and_does_not_skip_other_sites_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            report = runner.auth.Report(Path(directory))
            deployment = object()
            consumers = [SimpleNamespace(label="A"), SimpleNamespace(label="B")]
            def setup(report, deployment):
                return consumers
            with patch.object(runner.auth, "internal_browser", side_effect=runner.auth.EvidenceError("Internal failed")) as internal, \
                    patch.object(runner.auth, "inspector_browser") as inspector, \
                    patch.object(runner.auth, "consumer_fixtures", side_effect=setup), \
                    patch.object(runner.auth, "guest_cart_browser") as storefront:
                runner.auth.browser_tests(report, deployment)
            internal.assert_called_once_with(report, deployment)
            inspector.assert_called_once_with(report, deployment)
            storefront.assert_called_once_with(report, deployment, consumers[0], consumers[1])
            self.assertTrue(any(check["status"] == "BLOCKED" for check in report.checks))
            with patch.object(runner.auth, "internal_browser"), patch.object(runner.auth, "inspector_browser"), \
                    patch.object(runner.auth, "consumer_fixtures", side_effect=runner.auth.EvidenceError("Auth failed")), \
                    patch.object(runner.auth, "guest_cart_browser") as storefront:
                report = runner.auth.Report(Path(directory))
                runner.auth.browser_tests(report, deployment)
            storefront.assert_not_called()
            self.assertTrue(any(check["id"] == "browser:storefront:scenario" and check["status"] == "BLOCKED"
                                for check in report.checks))

    def test_private_modes_reject_mixed_and_non_boolean_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "configuration.json"
            for mode in [{"browserOnly": True, "addressOnly": True},
                         {"browserOnly": True, "sqlOnly": True}, {"addressOnly": True, "sqlOnly": True},
                         {"mutations": True, "sqlOnly": True}, {"mutations": True, "browserOnly": True},
                         {"mutations": True, "addressOnly": True}, {"mutations": "true"},
                         {"browserOnly": "true"}, {"addressOnly": 1}, {"sqlOnly": "false"}]:
                path.write_text(json.dumps({"schemaVersion": 1, "values": {}, **mode}))
                with self.subTest(mode=mode), patch.dict(os.environ, {"AUTH_ASSURANCE_MANIFEST_FILE": str(path)}):
                    with self.assertRaises(ValueError):
                        config.load()
        with patch.object(runner.auth, "Deployment") as deployment:
            for arguments in [["--browser-only", "--address-only"], ["--mutations", "--sql-only"],
                              ["--mutations", "--browser-only"], ["--mutations", "--address-only"]]:
                with self.assertRaises(SystemExit), patch("sys.stderr"):
                    runner.main(arguments)
            deployment.assert_not_called()

    def recovery_fixture(self):
        run_id = "20261110T195420Z-c3d67675-a361-41a8-baf8-5f89cc43eedf"
        ledger = {"runId": run_id, "reportPrefix": "auth-assurance/" + run_id + "/",
                  "imageDigest": "sha256:" + "a" * 64}
        report = {"provenance": {"runId": run_id, "reportPrefix": ledger["reportPrefix"],
                                 "imageDigest": ledger["imageDigest"]},
                  "counts": {"BLOCKED": 1}, "outcome": "BLOCKED",
                  "checks": [{"id": "unfinished", "status": "BLOCKED"}]}
        files = {"report.pdf": b"%PDF-1.7\nunit fixture", "report.html": b"<html>fixture</html>",
                 "report.json": json.dumps(report).encode(), "junit.xml": b"<testsuites/>"}
        document = {"runId": run_id, "prefix": ledger["reportPrefix"],
                    "checks": [{"name": name, "status": "PASS"} for name in ["runtime-identity", "report-readback"]],
                    "artifacts": {name: {"content": base64.b64encode(data).decode(), "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()}}
        return document, ledger

    def test_recovered_reports_are_complete_hash_verified_private_and_keep_blocked_outcome(self):
        document, ledger = self.recovery_fixture()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "reports"
            result = runner.verify_recovered_reports(document, ledger, output)
            self.assertEqual(result["outcome"], "BLOCKED")
            self.assertTrue(result["uploaded"])
            self.assertEqual(result["counts"], {"BLOCKED": 1})
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            self.assertEqual(len(list(output.iterdir())), 5)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in output.iterdir()))

    def test_recovery_transfer_bound_accepts_four_mib_and_rejects_one_byte_more(self):
        for extra in [0, 1]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as directory:
                document, ledger = self.recovery_fixture()
                others = sum(value["bytes"] for name, value in document["artifacts"].items() if name != "report.pdf")
                data = b"%PDF-" + b"x" * (4 * 1024 * 1024 + extra - others - 5)
                document["artifacts"]["report.pdf"] = {
                    "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                    "content": base64.b64encode(data).decode()}
                output = Path(directory) / "reports"
                if extra:
                    with self.assertRaisesRegex(runner.RunnerError, "exceed"):
                        runner.verify_recovered_reports(document, ledger, output)
                    self.assertFalse(output.exists())
                else:
                    self.assertEqual(runner.verify_recovered_reports(document, ledger, output)["outcome"], "BLOCKED")

    def test_recovered_report_tampering_never_creates_a_success_shaped_artifact_directory(self):
        for defect in ["run", "prefix", "missing-pdf", "checksum", "encoding", "size", "failed-runtime-check",
                       "missing-runtime-check", "image", "counts", "outcome", "assertions",
                       "duplicate-assertions", "pdf-content"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                document, ledger = self.recovery_fixture()
                if defect in {"run", "prefix"}:
                    document["runId" if defect == "run" else "prefix"] = "foreign"
                elif defect == "missing-pdf":
                    del document["artifacts"]["report.pdf"]
                elif defect == "checksum":
                    document["artifacts"]["report.pdf"]["sha256"] = "b" * 64
                elif defect == "encoding":
                    document["artifacts"]["report.pdf"]["content"] = "not-valid-base64!"
                elif defect == "size":
                    document["artifacts"]["report.pdf"]["bytes"] += 1
                elif defect == "failed-runtime-check":
                    document["checks"][0]["status"] = "FAIL"
                elif defect == "missing-runtime-check":
                    document["checks"].pop()
                elif defect == "pdf-content":
                    data = b"not a PDF"
                    document["artifacts"]["report.pdf"] = {"bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(), "content": base64.b64encode(data).decode()}
                else:
                    report = json.loads(base64.b64decode(document["artifacts"]["report.json"]["content"]))
                    if defect == "image":
                        report["provenance"]["imageDigest"] = "sha256:" + "b" * 64
                    elif defect == "counts":
                        report["counts"] = {"BLOCKED": True}
                    elif defect == "outcome":
                        report["outcome"] = "PASS"
                    elif defect == "assertions":
                        report["checks"][0]["status"] = "FAIL"
                    else:
                        report["checks"] *= 2
                    data = json.dumps(report).encode()
                    document["artifacts"]["report.json"] = {"bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(), "content": base64.b64encode(data).decode()}
                output = Path(directory) / "reports"
                with self.assertRaises(runner.RunnerError):
                    runner.verify_recovered_reports(document, ledger, output)
                self.assertFalse(output.exists())

    def test_log_reader_uses_text_because_installed_cli_corrupts_nested_json_quotes(self):
        raw = 'Connecting to the container...\n2026-11-10T20:00:00Z AUTH_ASSURANCE_RESULT:{"runId":"fixture"}\n'
        ledger = {"resourceGroup": "group", "jobName": "job", "execution": "execution"}
        with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=raw)) as process:
            lines = runner.log_lines("subscription", ledger, "replica")
        args = process.call_args.args[0]
        self.assertEqual(args[args.index("--format") + 1], "text")
        self.assertEqual(lines[-1]["Log"].split("AUTH_ASSURANCE_RESULT:", 1)[1], '{"runId":"fixture"}')

    def test_cleanup_waits_for_control_plane_deletion_without_deleting_again(self):
        ledger, job = self.fixtures()
        calls = []
        lists = iter([[job], [job], []])

        def azure(*args):
            calls.append(args)
            if args[2] == "list":
                return next(lists)

        with patch.object(runner.time, "sleep") as sleep:
            runner.cleanup(azure, ledger, lambda: None)
        self.assertEqual(len([args for args in calls if args[2] == "delete"]), 1)
        sleep.assert_called_once_with(5)
        self.assertEqual(ledger["computeCleanup"], "verified")

    def test_cleanup_timeout_remains_unverified_and_does_not_repeat_deletion(self):
        ledger, job = self.fixtures()
        calls = []

        def azure(*args):
            calls.append(args)
            return [job] if args[2] == "list" else None

        with patch.object(runner.time, "sleep") as sleep, self.assertRaises(runner.RunnerError):
            runner.cleanup(azure, ledger, lambda: self.fail("Unverified cleanup must not be persisted as complete"))
        self.assertEqual(sleep.call_count, 12)
        self.assertEqual(len([args for args in calls if args[2] == "delete"]), 1)
        self.assertNotEqual(ledger.get("computeCleanup"), "verified")

    def test_real_azure_wrapper_accepts_empty_successful_job_deletion_but_not_empty_reads_or_cli_failures(self):
        deployment = runner.auth.Deployment.__new__(runner.auth.Deployment)
        deployment.runtime = None
        deployment.subscription = "test-subscription"
        ledger, job = self.fixtures()
        outputs = iter([json.dumps([job]), "", "[]"])
        with patch.object(runner.auth, "command", side_effect=lambda *args, **kwargs: next(outputs)):
            runner.cleanup(deployment.azure, ledger, lambda: None)
        self.assertEqual(ledger["computeCleanup"], "verified")
        with patch.object(runner.auth, "command", return_value=""), self.assertRaises(runner.auth.EvidenceError):
            deployment.azure("containerapp", "job", "list", "-g", "group")
        with patch.object(runner.auth, "command", side_effect=runner.auth.EvidenceError("az delete failed")), \
                self.assertRaises(runner.auth.EvidenceError):
            deployment.azure("containerapp", "job", "delete", "-g", "group", "-n", "job", "--yes")

    def test_recovery_cli_reads_only_and_preserves_original_failure_in_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            document, ledger = self.recovery_fixture()
            ledger.update({"subscription": "subscription", "resourceGroup": "group", "jobName": "job",
                           "jobId": "/subscriptions/subscription/resourceGroups/group/providers/Microsoft.App/jobs/job",
                           "computeCleanup": "unverified", "uploaded": False,
                           "error": {"detail": "Original log parsing failure"}})
            path = Path(directory) / "lifecycle.json"
            path.write_text(json.dumps(ledger))
            calls = []

            def azure(*args):
                calls.append(args)
                self.assertEqual(args, ("containerapp", "job", "list", "-g", "group"))
                return []

            deployment = SimpleNamespace(azure=azure, subscription="subscription", group="group")
            with patch.object(runner.shutil, "which", return_value="/tool"), \
                    patch.object(runner.auth, "Deployment", return_value=deployment), \
                    patch.object(runner, "recover_reports",
                                 side_effect=lambda d, l, out: runner.verify_recovered_reports(document, l, out)), \
                    patch("builtins.print"):
                self.assertEqual(runner.main(["--recover-reports", str(path)]), 2)
            final = json.loads(path.read_text())
            self.assertEqual(final["error"], ledger["error"])
            self.assertEqual(final["computeCleanup"], "verified")
            self.assertTrue(final["uploaded"])
            self.assertEqual(len(calls), 1)
            self.assertTrue((Path(final["localReportsDirectory"]) / "report.pdf").is_file())

    def fixtures(self):
        ledger = {"runId": "test-run", "resourceGroup": "group", "jobName": "job",
                  "jobId": "/subscriptions/test/resourceGroups/group/providers/Microsoft.App/jobs/job",
                  "environmentId": "/environment"}
        job = {"id": ledger["jobId"], "tags": {"purpose": "auth-assurance", "auth-assurance-run": "test-run"},
               "properties": {"environmentId": "/environment"}}
        return ledger, job

    def test_exact_cleanup_is_idempotent_and_preserves_every_other_job(self):
        ledger, job = self.fixtures()
        remaining = [job, {"id": "/unrelated"}]
        deleted = []

        def azure(*args):
            if args[2] == "list":
                return remaining.copy()
            self.assertEqual(args, ("containerapp", "job", "delete", "-g", "group", "-n", "job", "--yes"))
            remaining.remove(job)
            deleted.append(job["id"])

        runner.cleanup(azure, ledger, lambda: None)
        runner.cleanup(azure, ledger, lambda: None)
        self.assertEqual(deleted, [job["id"]])
        self.assertEqual(remaining, [{"id": "/unrelated"}])
        self.assertEqual(ledger["computeCleanup"], "verified")

    def test_changed_tags_environment_or_resource_id_prevent_deletion(self):
        for mutation in ["id", "run", "purpose", "environment"]:
            ledger, job = self.fixtures()
            if mutation == "id":
                job["id"] = "/another"
            elif mutation == "environment":
                job["properties"]["environmentId"] = "/another"
            else:
                job["tags"]["auth-assurance-run" if mutation == "run" else "purpose"] = "another"
            with self.subTest(mutation=mutation), self.assertRaises(runner.RunnerError):
                runner.check_job(job, ledger)

    def test_order_mode_fails_closed_before_discovery_or_mutation(self):
        with patch.object(runner.auth, "Deployment") as deployment, \
                patch("sys.stderr"), self.assertRaises(SystemExit) as result:
            runner.main(["--include-orders"])
        self.assertEqual(result.exception.code, 2)
        deployment.assert_not_called()

    def test_secure_configuration_is_compressed_and_size_bounded(self):
        source = {"private": "fixture-only", "checks": ["repeated assertion"] * 100}
        encoded = runner.encode_configuration(source)
        self.assertEqual(json.loads(zlib.decompress(base64.b64decode(encoded))), source)
        with self.assertRaises(runner.RunnerError):
            runner.encode_configuration({"noise": os.urandom(20000).hex()})

    def test_inventory_restores_only_after_failure_with_missing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "report"
            output.mkdir()
            report = runner.auth.Report(output)
            calls = []

            def command(arguments, **kwargs):
                calls.append(arguments[:3])
                if len(calls) == 1:
                    raise runner.auth.EvidenceError("Missing restore assets")
                if arguments[1] == "test":
                    filename = "functions.json" if "api-functions.Tests" in arguments[2] else "mcp.json"
                    inventory = ([{"Name": "Fixture", "Triggers": ["Timer"]}]
                                 if filename == "functions.json" else
                                 [{"Name": "FixtureTool", "Policy": {"Public": False}}])
                    (output / filename).write_text(json.dumps(inventory))
                return "Configured runner completed"

            with patch.object(runner.auth, "ROOT", root), patch.object(runner.auth, "command", side_effect=command):
                runner.auth.export_inventory(report, offline=False)
            self.assertEqual([call[1] for call in calls], ["test", "restore", "test", "test"])
            self.assertEqual(set(report.inventory), {
                "functions", "mcp", "functionSurfaces", "mcpToolSurfaces",
            })
            assets = root / "api-functions.Tests/obj/project.assets.json"
            assets.parent.mkdir(parents=True)
            assets.write_text("{}")
            calls.clear()
            with patch.object(runner.auth, "ROOT", root), patch.object(runner.auth, "command", side_effect=command), \
                    self.assertRaises(runner.auth.EvidenceError):
                runner.auth.export_inventory(runner.auth.Report(output), offline=False)
            self.assertEqual([call[1] for call in calls], ["test"])

    def test_controller_cleans_exact_job_after_success_or_partial_provision_and_execution_failure(self):
        for failure in [None, "provision", "execution", "cleanup", "browser", "sql", "mutations", "address",
                        "host-blocked", "host-failed"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                jobs = []
                deleted = []
                configurations = []

                def ledger():
                    return json.loads(next((root / ".auth-results").glob("*/lifecycle.json")).read_text())

                def azure(*args):
                    if args[:3] == ("deployment", "group", "create"):
                        parameter_file = args[args.index("--parameters") + 1][1:]
                        document = json.loads(Path(parameter_file).read_text())
                        configuration = json.loads(zlib.decompress(base64.b64decode(
                            document["parameters"]["configuration"]["value"])))
                        configurations.append(configuration)
                        if failure in {"browser", "sql", "mutations", "address"}:
                            self.assertIs(configuration["browserOnly"], failure == "browser")
                            self.assertIs(configuration["sqlOnly"], failure == "sql")
                            self.assertIs(configuration["addressOnly"], failure == "address")
                            self.assertIs(configuration["mutations"], failure == "mutations")
                            if failure in {"sql", "mutations"}:
                                self.assertFalse(any(key.startswith("AUTH_TEST_CONSUMER_") for key in configuration["values"]))
                        current = ledger()
                        jobs.append({"id": current["jobId"], "tags": {
                            "purpose": "auth-assurance", "auth-assurance-run": current["runId"]},
                            "properties": {"environmentId": "/environment"}})
                        if failure == "provision":
                            raise runner.RunnerError("Partial provisioning failed")
                    elif args[:3] == ("acr", "repository", "show"):
                        return {"digest": "sha256:" + "a" * 64}
                    elif args[:3] == ("containerapp", "job", "show"):
                        return jobs[0]
                    elif args[:3] == ("containerapp", "job", "start"):
                        return {"name": "execution"}
                    elif args[:3] == ("containerapp", "job", "list"):
                        return jobs.copy()
                    elif args[:3] == ("containerapp", "job", "delete"):
                        if failure == "cleanup":
                            raise runner.RunnerError("Deletion failed")
                        deleted.append(jobs.pop()["id"])
                    else:
                        self.fail("Unexpected Azure command: " + repr(args))

                values = {"AZURE_ENV_NAME": "selected", "SQL_DATABASE_NAME": "database",
                          "AUTH_TEST_CONSUMER_A_STATE": "ready", "AUTH_TEST_CONSUMER_B_STATE": "ready"}
                deployment = SimpleNamespace(azure=azure, subscription="subscription", group="group",
                                             values=values, required=values.__getitem__)
                resources = (
                    {"tenantId": "tenant"},
                    {"id": "/environment", "name": "environment", "location": "region"},
                    {"name": "identity", "clientId": "client", "principalId": "principal"},
                    {"name": "registry"},
                    {"primaryEndpoints": {
                        "blob": "https://storage.example.invalid/",
                        "table": "https://storage.table.example.invalid/",
                    }},
                    {"fullyQualifiedDomainName": "sql.example.invalid"},
                    {"defaultHostname": "site.example.invalid"},
                )

                def result(*args):
                    if failure == "execution":
                        raise runner.RunnerError("No complete report")
                    if failure == "host-failed":
                        return {"outcome": "FAIL", "counts": {"FAIL": 1}}
                    return {"outcome": "BLOCKED", "counts": {"BLOCKED": 1}}

                host_status = "BLOCKED" if failure == "host-blocked" else "FAIL" if failure == "host-failed" else "PASS"
                def host_checks(report):
                    report.add("required:functions-middleware-host-denials", "required", host_status,
                               "Local loopback-only worker evidence; no deployed triggers.")

                with patch.object(runner, "ROOT", root), \
                        patch.object(runner.shutil, "which", return_value="/tool"), \
                        patch.object(runner.auth, "Deployment", return_value=deployment), \
                        patch.object(runner, "discover", return_value=resources), \
                        patch.object(runner.auth, "export_inventory") as inventory, \
                        patch.object(runner.auth, "contracts") as contracts, \
                        patch.object(runner.auth, "functions_host_tests", side_effect=host_checks) as host, \
                        patch.object(runner.auth, "infra") as infra, \
                        patch.object(runner.auth, "consumer_fixtures") as consumers, \
                        patch.object(runner, "context_files", return_value=[]), \
                        patch.object(runner, "snapshot", return_value="b" * 64), \
                        patch.object(runner, "command") as build_command, \
                        patch.object(runner.subprocess, "check_output", return_value="revision"), \
                        patch.object(runner, "wait_result", side_effect=result), \
                        patch("builtins.print"):
                    code = runner.main(["--browser-only"] if failure == "browser" else
                                       ["--sql-only"] if failure == "sql" else
                                       ["--mutations"] if failure == "mutations" else
                                       ["--address-only"] if failure == "address" else [])
                if failure in {"browser", "sql", "mutations", "address"}:
                    inventory.assert_not_called()
                    contracts.assert_not_called()
                    infra.assert_not_called()
                    host.assert_not_called()
                else:
                    host.assert_called_once()
                    host_check, = configurations[0]["localReport"]["checks"]
                    self.assertEqual(host_check["status"], host_status)
                    self.assertEqual(host_check["id"], "required:functions-middleware-host-denials")
                if failure in {"sql", "mutations"}:
                    consumers.assert_not_called()
                build_arguments = build_command.call_args.args[0]
                dockerfile_index = build_arguments.index("--file")
                self.assertEqual(Path(build_arguments[dockerfile_index + 1]),
                                 Path(build_arguments[dockerfile_index + 2]) / "tests/auth/container/Dockerfile")
                final = ledger()
                self.assertLessEqual(len(final["jobName"]), 32)
                self.assertRegex(final["jobName"], r"^[a-z][a-z0-9-]*[a-z0-9]$")
                self.assertNotIn("--", final["jobName"])
                self.assertEqual(len(configurations), 1)
                uses_mutation_storage = failure not in {"browser", "sql"}
                if uses_mutation_storage:
                    table_name = final["temporaryTableName"]
                    self.assertRegex(table_name, r"^awtest[0-9a-f]{32}$")
                    self.assertEqual(configurations[0]["storage"]["mutationTableName"], table_name)
                    self.assertTrue(configurations[0]["storage"]["tableEndpoint"].startswith("https://"))
                else:
                    self.assertNotIn("temporaryTableName", final)
                    self.assertNotIn("mutationTableName", configurations[0]["storage"])
                    self.assertNotIn("tableEndpoint", configurations[0]["storage"])
                self.assertEqual(code, 1 if failure == "host-failed" else
                                 2 if failure in {None, "browser", "sql", "mutations", "address", "host-blocked"} else 3)
                self.assertEqual(final["uploaded"], failure in {
                    None, "cleanup", "browser", "sql", "mutations", "address", "host-blocked", "host-failed"})
                if failure == "cleanup":
                    self.assertIn("unverified", final["computeCleanup"])
                    self.assertEqual(final["cleanupError"]["detail"], "Deletion failed")
                    self.assertEqual(len(jobs), 1)
                else:
                    self.assertEqual(final["computeCleanup"], "verified")
                    self.assertEqual(deleted, [final["jobId"]])
                    self.assertEqual(jobs, [])

    def test_only_one_complete_matching_upload_result_is_accepted(self):
        ledger, _ = self.fixtures()
        ledger.update({"execution": "execution", "reportPrefix": "auth-assurance/test-run/"})
        summary = {"runId": ledger["runId"], "uploaded": True, "prefix": ledger["reportPrefix"],
                   "outcome": "BLOCKED", "counts": {"BLOCKED": 1},
                   "artifacts": {name: {"bytes": 20, "sha256": "a" * 64}
                                 for name in ["report.pdf", "report.html", "report.json", "junit.xml"]}}

        def azure(*args):
            return {"properties": {"status": "Failed"}} if args[2] == "execution" else [{"name": "replica"}]

        def lines(document):
            return [{"Log": "AUTH_ASSURANCE_RESULT:" + json.dumps(document)}]

        self.assertEqual(runner.wait_result(azure, ledger, 10, lambda replica: lines(summary)), summary)
        for changed in [{**summary, "uploaded": False}, {**summary, "runId": "other"},
                        {**summary, "outcome": "unknown"}, {**summary, "prefix": "other/"},
                        *[{**summary, "counts": counts} for counts in
                          [{}, {"BLOCKED": True}, {"BLOCKED": -1}, {"unknown": 1}, {"PASS": 1}]]]:
            with self.subTest(changed=changed), self.assertRaises(runner.RunnerError):
                runner.wait_result(azure, ledger, 10, lambda replica: lines(changed))
        for name in summary["artifacts"]:
            changed = copy.deepcopy(summary)
            del changed["artifacts"][name]
            with self.subTest(missing=name), self.assertRaises(runner.RunnerError):
                runner.wait_result(azure, ledger, 10, lambda replica: lines(changed))

    def test_context_contains_needed_sources_but_no_credentials_caches_or_outputs(self):
        paths = runner.context_files()
        self.assertIn(Path("tests/auth/container/Dockerfile"), paths)
        self.assertIn(Path("infra/testing/auth-assurance-job.bicep"), paths)
        self.assertIn(Path("api/dab-config.json"), paths)
        self.assertIn(Path("app/.npmrc"), paths)
        self.assertIn(Path("seed-job/dockerfile"), paths)
        self.assertIn(Path("scripts/hooks/postprovision.sh"), paths)
        self.assertIn(Path("tests/scripts/test_keyvault_firewall.py"), paths)
        self.assertIn(Path("tests/scripts/test-seed-sql-identity.py"), paths)
        self.assertIn(Path("tests/scripts/seed-sql-identity-probe.cjs"), paths)
        self.assertIn(Path("mcp-inspector/gateway.mjs"), paths)
        self.assertIn(Path("mcp-inspector/package-lock.json"), paths)
        for path in paths:
            self.assertNotIn(".azure", path.parts)
            self.assertNotIn("node_modules", path.parts)
            self.assertNotIn("obj", path.parts)
            self.assertFalse(any(part == ".env" or part.startswith(".env.") for part in path.parts))
            self.assertFalse((ROOT / path).is_symlink())

    def test_runner_is_not_wired_into_application_deployment(self):
        for path in [ROOT / "azure.yaml", ROOT / "infra/main.bicep", *(ROOT / "scripts/hooks").glob("*")]:
            if path.is_file():
                self.assertNotIn("run-auth-assurance-job", path.read_text())
                self.assertNotIn("auth-assurance-job.bicep", path.read_text())
        template = (ROOT / "infra/testing/auth-assurance-job.bicep").read_text()
        self.assertIn("@secure()\nparam configuration", template)
        self.assertIn("replicaRetryLimit: 0", template)
        self.assertNotIn("roleAssignments", template)
        self.assertNotIn("ingress:", template)

    def test_restricted_config_rejects_unreviewed_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "configuration.json"
            path.write_text(json.dumps({"schemaVersion": 1, "values": {"API_URL": "https://api.example.invalid"}}))
            with patch.dict(os.environ, {"AUTH_ASSURANCE_MANIFEST_FILE": str(path)}):
                self.assertEqual(config.load()["values"]["API_URL"], "https://api.example.invalid")
                path.write_text(json.dumps({"schemaVersion": 1, "values": {"UNRELATED_SECRET": "not-allowed"}}))
                with self.assertRaises(ValueError):
                    config.load()

    def test_runtime_cannot_use_management_api_or_persist_fixture_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "configuration.json"
            path.write_text(json.dumps({"schemaVersion": 1, "values": {
                "AZURE_SUBSCRIPTION_ID": "test", "AZURE_RESOURCE_GROUP": "group",
                "AZURE_ENV_NAME": "selected", "SERVICE_APP_NAME": "site"}, "storefrontHostname": "site.example.invalid"}))
            with patch.dict(os.environ, {"AUTH_ASSURANCE_MANIFEST_FILE": str(path)}):
                d = runner.auth.Deployment("selected")
                self.assertEqual(d.azure("staticwebapp", "show", "--name", "site", "--resource-group", "group"),
                                 {"defaultHostname": "site.example.invalid"})
                with self.assertRaises(runner.auth.EvidenceError):
                    d.azure("role", "assignment", "list")
                with self.assertRaises(runner.auth.EvidenceError):
                    runner.auth.persist_fixture_values(d, {})
                with self.assertRaises(runner.auth.EvidenceError):
                    runner.auth.Deployment("wrong")


class PortableReportTests(unittest.TestCase):
    def document(self):
        return {"checks": [{"id": "test", "group": "unit", "status": "BLOCKED",
                            "detail": '<script src="https://external.invalid">unsafe</script>'}]}

    def test_report_escapes_text_preserves_blockers_and_hashes_artifacts(self):
        document = reporting.combine([("private", self.document())], {"computeCleanup": "pending"})
        with tempfile.TemporaryDirectory() as directory:
            reporting.render(document, directory)
            html = (Path(directory) / "report.html").read_text()
            self.assertNotIn('<script src=', html)
            self.assertIn("&lt;script", html)
            self.assertIn("default-src", html)
            self.assertIn("pending", html)
            manifest = reporting.artifact_manifest(directory)
            self.assertEqual(set(manifest), {"report.json", "report.html", "junit.xml"})
            self.assertEqual(document["outcome"], "BLOCKED")
            self.assertIn('errors="1"', (Path(directory) / "junit.xml").read_text())

    def test_duplicate_empty_and_invalid_status_reports_fail_explicitly(self):
        for documents in [[], [("p", self.document()), ("p", self.document())]]:
            with self.assertRaises(ValueError):
                reporting.combine(documents, {})
        document = copy.deepcopy(self.document())
        document["checks"][0]["status"] = "SKIPPED-AS-SUCCESS"
        with self.assertRaises(ValueError):
            reporting.combine([("p", document)], {})

    def test_pdf_renderer_failure_is_not_a_success_shaped_fallback(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(reporting.subprocess, "run") as process:
            process.return_value.returncode = 1
            with self.assertRaises(RuntimeError):
                reporting.pdf(directory)

    def test_upload_uses_only_existing_container_exact_prefix_and_verified_readback(self):
        calls = []
        blobs = {}
        corrupt = False

        class Blob:
            def __init__(self, path):
                self.path = path

            def upload_blob(self, data, **kwargs):
                self_test.assertIs(kwargs["overwrite"], False)
                self_test.assertNotIn(self.path, blobs)
                blobs[self.path] = data

            def download_blob(self):
                return SimpleNamespace(readall=lambda: b"corrupt" if corrupt else blobs[self.path])

        class Service:
            def __init__(self, endpoint, credential):
                self_test.assertEqual(endpoint, "https://storage.example.invalid")
                self_test.assertEqual(credential, "managed-identity-only")

            def get_container_client(self, name):
                calls.append(name)
                return SimpleNamespace(get_blob_client=lambda path: Blob(path))

        self_test = self
        fake = ModuleType("azure.storage.blob")
        fake.BlobServiceClient = Service
        fake.ContentSettings = lambda **kwargs: kwargs
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            reporting.render(reporting.combine([("test", self.document())], {}), directory)
            (directory / "report.pdf").write_bytes(b"%PDF-1.7\nunit fixture")
            with patch.dict("sys.modules", {"azure.storage.blob": fake}):
                manifest = entrypoint.upload({"storage": {"endpoint": "https://storage.example.invalid",
                    "prefix": "auth-assurance/test-run/"}}, directory, "managed-identity-only")
            self.assertEqual(calls, ["adventureworks-receipts"])
            self.assertEqual(len(manifest), 4)
            self.assertEqual(len(blobs), 5)
            self.assertTrue(all(path.startswith("auth-assurance/test-run/") for path in blobs))
            corrupt = True
            blobs.clear()
            with patch.dict("sys.modules", {"azure.storage.blob": fake}), \
                    self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                entrypoint.upload({"storage": {"endpoint": "https://storage.example.invalid",
                    "prefix": "auth-assurance/test-run/"}}, directory, "managed-identity-only")


if __name__ == "__main__":
    unittest.main()
