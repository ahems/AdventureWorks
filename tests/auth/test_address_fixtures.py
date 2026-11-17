import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit


SPEC = importlib.util.spec_from_file_location("address_fixtures", Path(__file__).with_name("address_fixture_suite.py"))
fixtures = importlib.util.module_from_spec(SPEC)
sys.path.insert(0, str(Path(__file__).parent))
SPEC.loader.exec_module(fixtures)


class FakeAzureError(Exception):
    pass


class FixtureLedger:
    def __init__(self, defect=None):
        self.records = []
        self.events = []
        self.defect = defect

    def record(self, residual):
        if self.defect == "ledger-record-failure":
            raise FakeAzureError("storage unavailable")
        self.records.append(residual)
        self.events.append(("record", residual["kind"]))

    def update(self, residual):
        if self.defect == "ledger-update-failure":
            raise FakeAzureError("storage unavailable")
        self.events.append(("update", residual["state"]))


class AddressFixtureTests(unittest.TestCase):
    run_id = "20261111T140000Z-87cc8764-ab20-4866-ab70-e92136a9d8e6"
    marker = "AuthAssurance-87cc8764ab204866ab70e92136a9d8e6"

    def test_admin_token_uses_the_captured_deployment(self):
        values = {"API_MCP_URL": "https://selected.example/mcp"}
        deployment = SimpleNamespace(values=values, required=lambda key: values[key])
        observed = []

        class Helper:
            AuthError = ValueError

            def NoRedirect(self):
                return object()

            def deployment(self, *args):
                raise AssertionError("The fixture run must not reread the selected environment")

            def session(self, opener, args, base, audience):
                observed.append((base, audience))
                return {"access_token": "fixture-token"}

        with patch.object(fixtures.auth, "load_auth_helper", return_value=Helper()), \
                patch.object(fixtures.urllib.request, "build_opener", return_value=object()):
            self.assertEqual(fixtures.admin_dab_token(deployment), "fixture-token")
        self.assertEqual(observed, [("https://selected.example", "https://selected.example/dab")])

    def configuration(self):
        values = {"API_FUNCTIONS_URL": "https://functions.example.invalid",
                  "API_URL": "https://dab.example.invalid/graphql/"}
        for label, owner in [("A", "7"), ("B", "8")]:
            prefix = "AUTH_TEST_CONSUMER_" + label + "_"
            values.update({prefix + "STATE": "ready", prefix + "BUSINESS_ENTITY_ID": owner,
                           prefix + "EMAIL": label + "@example.invalid", prefix + "PASSWORD": "test-not-a-secret"})
        return {"addressOnly": True, "runId": self.run_id, "values": values}

    def scenario(self, defect=None):
        configuration = self.configuration()
        deployment = SimpleNamespace(runtime=True, values=configuration["values"],
                                     required=lambda key: configuration["values"][key])
        ledger, calls, audits = FixtureLedger(defect), [], []
        addresses, links = {}, []
        tampered = False

        def audit(report):
            audits.append(True)
            data = {
                "ownersMatch": True,
                "ownerLinks": [sum(link["owner"] == owner for link in links) for owner in [7, 8]],
                "addresses": [copy.deepcopy(addresses[key]) for key in sorted(addresses)],
                "links": sorted(copy.deepcopy(links), key=lambda row: (row["addressId"], row["owner"], row["type"])),
            }
            if defect == "nonempty-baseline" and len(audits) == 1:
                data["ownerLinks"] = [1, 0]
            if defect == "changed-sql" and len(audits) >= 3 and data["addresses"]:
                data["addresses"][0]["city"] = "changed"
            if defect == "foreign-link" and len(audits) >= 4 and data["addresses"]:
                data["addresses"][0]["foreignLinks"] = 1
            return data

        def owned(owner):
            return sorted({row["addressId"] for row in links if row["owner"] == owner})

        def payload(address_id):
            address = addresses[address_id]
            return {"addressID": address_id, "addressLine1": address["marker"],
                    "city": address["city"]}

        def request(method, url, *, token=None, data=None, headers=None):
            nonlocal tampered
            calls.append((method, url, data, token, headers))
            parsed = urlsplit(url)
            owner = int(token) if token in {"7", "8"} else None
            if parsed.hostname == "dab.example.invalid":
                if parsed.path == "/api/StateProvince":
                    status, body = 200, {"value": [{"StateProvinceID": 1}]}
                elif method == "POST" and parsed.path == "/api/BusinessEntityAddress" and token == "admin":
                    self.assertEqual(ledger.events[-1], ("record", "address-fixture-link"))
                    if defect != "shared-not-linked":
                        links.append({"addressId": data["AddressID"], "owner": data["BusinessEntityID"],
                                      "type": data["AddressTypeID"], "rowGuid": "link", "modified": "time"})
                    if defect == "link-timeout":
                        raise fixtures.auth.EvidenceError("Uncertain link request")
                    status, body = 201, {"value": [data]}
                elif method == "GET":
                    filters = parse_qs(parsed.query)["$filter"][0]
                    address_id = int(filters.split("AddressID eq ")[1])
                    result = [{"BusinessEntityID": owner, "AddressID": row["addressId"],
                               "AddressTypeID": 1 if tampered else row["type"]}
                              for row in links if row["owner"] == owner and row["addressId"] == address_id]
                    if defect == "link-control-invalid" and result:
                        result = []
                    status, body = 200, {"value": result}
                elif parsed.path.rstrip("/") == "/graphql":
                    if defect == "link-graphql-allowed":
                        status, body = 200, {"errors": [{"extensions": {"code": "OTHER"}}]}
                    else:
                        status, body = 200, {"data": None, "errors": [{"extensions": {"code": "AUTH_NOT_AUTHORIZED"}}]}
                else:
                    if defect == "link-create-allowed" and method == "POST":
                        status, body = 409, {"error": "duplicate"}
                    elif defect == "link-update-allowed" and method == "PATCH":
                        status, body = 404, {"error": "missing"}
                    else:
                        if defect == "link-denied-but-written":
                            tampered = True
                        status, body = 403, {"error": "denied"}
            elif parsed.path == "/api/addresses" and method == "POST":
                self.assertEqual(ledger.events[-1], ("record", "address-fixture"))
                address_id = 101 + len(addresses)
                addresses[address_id] = {"id": address_id, "marker": data["addressLine1"], "line2": None,
                                         "city": data["city"], "state": data["stateProvinceID"],
                                         "postal": data["postalCode"], "rowGuid": "address", "modified": "time",
                                         "foreignLinks": 0, "orderReferences": 0}
                links.append({"addressId": address_id, "owner": owner, "type": 2 if len(owned(owner)) == 0 else 3,
                              "rowGuid": "link", "modified": "time"})
                if defect == "create-timeout":
                    raise fixtures.auth.EvidenceError("Uncertain creation request")
                status, body = 201, payload(address_id)
            elif parsed.path == "/api/person-addresses":
                status, body = 200, [{"businessEntityID": owner}]
            elif parsed.path == "/api/addresses":
                ids = owned(owner)
                query = parse_qs(parsed.query)
                offset, limit = int(query.get("offset", ["0"])[0]), int(query.get("limit", ["100"])[0])
                ids = ids[offset:offset + limit]
                if defect == "wrong-page" and limit == 1 and len(addresses) == 5:
                    ids = [999]
                status, body = 200, [payload(address_id) if address_id in addresses else
                                     {"addressID": address_id, "addressLine1": self.marker} for address_id in ids]
            else:
                address_id = int(parsed.path.split("/addresses/")[1].split("/")[0])
                if method == "GET" and address_id in owned(owner):
                    status, body = 200, payload(address_id)
                elif method == "DELETE" and address_id in owned(owner):
                    if defect == "cleanup-failure":
                        status, body = 500, {"error": "cleanup failed"}
                    else:
                        links[:] = [row for row in links if not (row["addressId"] == address_id and row["owner"] == owner)]
                        if not any(row["addressId"] == address_id for row in links):
                            del addresses[address_id]
                        status, body = 204, None
                elif method == "PUT" and address_id == 105 and address_id in owned(owner):
                    if data["city"] == "Auth assurance":
                        status, body = 200, payload(address_id)
                    elif defect == "shared-change-allowed":
                        status, body = 200, payload(address_id)
                    else:
                        if defect == "shared-denied-but-written":
                            addresses[address_id]["city"] = data["city"]
                        status, body = 409, {"error": "This address is shared. Add a new address instead."}
                elif method != "GET" and defect == "write-allowed":
                    status, body = 200, {"addressID": address_id}
                else:
                    status, body = 403, {"error": f"Address {address_id} is not owned by the current user."}
            return status, {}, b"" if body is None else json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = fixtures.auth.Report(Path(directory))
            with patch.object(fixtures, "address_audit", side_effect=audit), \
                    patch.object(fixtures, "fixture_ledger", return_value=(ledger, FakeAzureError)), \
                    patch.object(fixtures, "admin_dab_token", return_value="admin"), \
                    patch.object(fixtures.auth.ConsumerSession, "token", lambda self, _: str(self.business_id)), \
                    patch.object(fixtures.auth, "http", side_effect=request):
                report.guarded("scenario", "ownership", lambda: fixtures.run(report, deployment, configuration))
            return report.checks, calls, audits, ledger, addresses, links

    def test_api_fixtures_are_ledgered_verified_and_cleaned(self):
        checks, calls, audits, ledger, addresses, links = self.scenario()
        self.assertTrue(all(check["status"] == "PASS" for check in checks), checks)
        creates = [call for call in calls if call[0] == "POST" and call[1].endswith("/api/addresses")]
        self.assertEqual(len(creates), 5)
        self.assertEqual(len(ledger.records), 6)
        self.assertTrue(all(item["state"] == "deleted" for item in ledger.records))
        admin_creates = [call for call in calls if call[0] == "POST" and call[3] == "admin"]
        self.assertEqual(len(admin_creates), 1)
        self.assertEqual(admin_creates[0][4]["X-MS-API-ROLE"], "executive-admin")
        self.assertEqual(len([check for check in checks if check["id"].startswith("address-links:")]), 52)
        self.assertEqual(len(audits), 5)
        self.assertEqual(addresses, {})
        self.assertEqual(links, [])

    def test_uncertain_fixture_write_never_retries_or_races_cleanup(self):
        for defect, expected_creates in [("create-timeout", 1), ("link-timeout", 5)]:
            with self.subTest(defect=defect):
                checks, calls, _, ledger, addresses, _ = self.scenario(defect)
                self.assertEqual(len([call for call in calls if call[0] == "POST" and
                                      call[1].endswith("/api/addresses")]), expected_creates)
                self.assertFalse(any(call[0] == "DELETE" for call in calls))
                self.assertTrue(any(item["state"] == "creation-requested" for item in ledger.records))
                self.assertTrue(addresses)
                self.assertTrue(any(check["id"] == "address-fixtures:cleanup-unverified" and
                                    check["status"] == "FAIL" for check in checks))

    def test_nonempty_consumer_never_triggers_fixture_writes(self):
        checks, calls, _, ledger, _, _ = self.scenario("nonempty-baseline")
        self.assertTrue(all(call[0] == "GET" for call in calls))
        self.assertEqual(ledger.records, [])
        self.assertTrue(any(check["status"] == "FAIL" for check in checks))

    def test_shared_fixture_requires_independent_persisted_link_before_host_probes(self):
        checks, calls, _, ledger, addresses, links = self.scenario("shared-not-linked")
        self.assertTrue(any(check["id"] == "address-fixtures-setup" and check["status"] == "FAIL"
                            for check in checks))
        self.assertFalse(any(call[1].rstrip("/").endswith("/graphql") for call in calls))
        self.assertTrue(all(item["state"] == "deleted" for item in ledger.records))
        self.assertEqual(addresses, {})
        self.assertEqual(links, [])

    def test_failed_probe_stops_writes_and_does_not_race_uncertain_cleanup(self):
        for defect in ["wrong-page", "write-allowed", "link-create-allowed", "link-update-allowed",
                       "link-graphql-allowed", "link-denied-but-written", "link-control-invalid",
                       "shared-change-allowed", "shared-denied-but-written"]:
            with self.subTest(defect=defect):
                checks, _, _, ledger, addresses, _ = self.scenario(defect)
                self.assertTrue(any(check["status"] == "FAIL" for check in checks))
                self.assertTrue(any(check["id"] == "address-fixtures:cleanup-unverified" for check in checks))
                self.assertTrue(addresses)
                self.assertTrue(all(item["state"] == "created" for item in ledger.records))

    def test_changed_sql_snapshot_fails_even_when_safe_cleanup_succeeds(self):
        checks, _, _, _, addresses, _ = self.scenario("changed-sql")
        self.assertTrue(any(check["id"] == "address-fixtures-unchanged" and check["status"] == "FAIL"
                            for check in checks))
        self.assertEqual(addresses, {})

    def test_foreign_references_and_failed_deletion_stop_cleanup(self):
        for defect in ["foreign-link", "cleanup-failure"]:
            with self.subTest(defect=defect):
                checks, calls, _, _, addresses, _ = self.scenario(defect)
                deletes = [call for call in calls if call[0] == "DELETE" and
                           call[3] in {"7", "8"} and "functions.example.invalid" in call[1] and
                           call[1].split("/")[-1] in {"101", "102", "103", "104", "105"}]
                # The host denial matrix includes two foreign DELETEs before cleanup.
                self.assertEqual(len(deletes), 2 if defect == "foreign-link" else 3)
                self.assertTrue(addresses)
                self.assertTrue(any(check["id"] == "address-fixtures:cleanup-unverified" and
                                    check["status"] == "FAIL" for check in checks))

    def test_cleanup_refuses_unknown_ids_foreign_owners_and_references(self):
        consumers = [SimpleNamespace(business_id=7), SimpleNamespace(business_id=8)]
        valid = {
            "ownersMatch": True, "ownerLinks": [1, 1],
            "addresses": [
                {"id": 101, "marker": self.marker, "foreignLinks": 0, "orderReferences": 0},
                {"id": 102, "marker": self.marker, "foreignLinks": 0, "orderReferences": 0},
            ],
            "links": [{"addressId": 101, "owner": 7}, {"addressId": 102, "owner": 8}],
        }
        fixtures.verify_cleanup_scope(valid, consumers, [101, 102], self.marker)
        for defect in ["unknown-id", "marker", "foreign", "order", "duplicate-link",
                       "foreign-owner", "other-owner-record", "owner-identity"]:
            with self.subTest(defect=defect):
                audit = copy.deepcopy(valid)
                if defect == "unknown-id":
                    audit["addresses"][1]["id"] = 103
                elif defect == "marker":
                    audit["addresses"][0]["marker"] = "unrelated"
                elif defect == "foreign":
                    audit["addresses"][0]["foreignLinks"] = 1
                elif defect == "order":
                    audit["addresses"][0]["orderReferences"] = 1
                elif defect == "duplicate-link":
                    audit["links"].append(copy.deepcopy(audit["links"][0]))
                elif defect == "foreign-owner":
                    audit["links"][0]["owner"] = 9
                elif defect == "other-owner-record":
                    audit["ownerLinks"][0] += 1
                else:
                    audit["ownersMatch"] = False
                with self.assertRaises(fixtures.auth.EvidenceError):
                    fixtures.verify_cleanup_scope(audit, consumers, [101, 102], self.marker)

    def test_fixture_writes_require_the_ephemeral_ledger(self):
        with self.assertRaises(fixtures.auth.EvidenceError):
            fixtures.fixture_ledger({"storage": {}})

    def test_ledger_failures_are_reported_and_do_not_trigger_further_creates(self):
        for defect, expected in [("ledger-record-failure", 0), ("ledger-update-failure", 1)]:
            with self.subTest(defect=defect):
                checks, calls, _, _, _, _ = self.scenario(defect)
                self.assertEqual(len([call for call in calls if call[0] == "POST" and
                                      call[1].endswith("/api/addresses")]), expected)
                self.assertTrue(any(check["id"] == "address-fixtures:cleanup-unverified" and
                                    check["status"] == "FAIL" for check in checks))
                self.assertTrue(any(check["id"] == "scenario" and check["status"] == "BLOCKED"
                                    for check in checks))

    def test_public_or_non_opted_in_mode_cannot_create_fixtures(self):
        for defect in ["not-private", "not-opted-in", "invalid-run"]:
            configuration = self.configuration()
            deployment = SimpleNamespace(runtime=defect != "not-private")
            if defect == "not-opted-in":
                configuration["addressOnly"] = False
            if defect == "invalid-run":
                configuration["runId"] = "foreign"
            with self.subTest(defect=defect), patch.object(fixtures, "address_audit") as audit, \
                    tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(fixtures.auth.EvidenceError):
                    fixtures.run(fixtures.auth.Report(Path(directory)), deployment, configuration)
                audit.assert_not_called()

    def test_audit_requires_single_complete_read_only_result(self):
        valid = {"addressAudit": {"ownersMatch": True, "ownerLinks": [0, 0], "addresses": [], "links": []}}
        for defect in [None, "exit", "missing", "duplicate", "malformed", "bad-shape", "timeout"]:
            document = copy.deepcopy(valid)
            if defect == "bad-shape":
                document["addressAudit"]["ownerLinks"] = [True, 0]

            def execute(args, *, stdout, **kwargs):
                self.assertEqual(args[2:], ["--address-audit"])
                if defect == "timeout":
                    raise subprocess.TimeoutExpired(args, 300)
                line = '{"addressAudit":invalid' if defect == "malformed" else json.dumps(document, separators=(",", ":"))
                if defect != "missing":
                    stdout.write((line + "\n").encode())
                if defect == "duplicate":
                    stdout.write((line + "\n").encode())
                stdout.flush()
                return SimpleNamespace(returncode=1 if defect == "exit" else 0)

            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory, \
                    patch.object(fixtures.subprocess, "run", side_effect=execute):
                report = fixtures.auth.Report(Path(directory))
                if defect:
                    with self.assertRaises(fixtures.auth.EvidenceError):
                        fixtures.address_audit(report)
                else:
                    self.assertEqual(fixtures.address_audit(report), valid["addressAudit"])

    def test_private_address_probe_has_no_sql_fixture_write_path(self):
        private = Path(__file__).parent / "private"
        source = (private / "AddressFixtures.cs").read_text()
        self.assertNotRegex(source, r"(?i)\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC|EXECUTE)\b")
        entrypoint = (private / "Program.cs").read_text()
        self.assertNotIn("--address-fixtures", entrypoint)
        self.assertIn("--address-audit", entrypoint)


if __name__ == "__main__":
    unittest.main()
