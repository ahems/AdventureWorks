import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("password_auth", Path(__file__).with_name("validate.py"))
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


class PasswordOwnershipTests(unittest.TestCase):
    def run_reads(self, defect=None):
        consumers = [SimpleNamespace(label=label, business_id=owner, password=password,
                                    token=lambda _, value=label: value + "-secret-token")
                     for label, owner, password in [("A", 7, "A-secret-password"), ("B", 8, "B-secret-password")]]
        calls = []

        def request(method, url, *, token, data):
            self.assertEqual((method, url), ("POST", "https://functions.example.invalid/api/password/verify"))
            owner = 7 if token == "A-secret-token" else 8
            correct = "A-secret-password" if owner == 7 else "B-secret-password"
            cross = owner != data["businessEntityID"]
            status, body = (403, {"error": "forbidden", "error_description": "You can only verify your own password."}) \
                if cross else (200, {"isValid": data["password"] == correct})
            calls.append((owner, cross))
            if defect == "cross-allowed" and cross:
                status, body = 200, {"isValid": False}
            elif defect == "wrong-denial" and cross:
                body["error_description"] = "Unrelated denial"
            elif defect == "non-boolean" and not cross:
                body["isValid"] = "true"
            elif defect == "inverted" and not cross:
                body["isValid"] = not body["isValid"]
            elif defect == "server-error":
                status = 500
            elif defect == "null":
                body = None
            return status, {}, b"secret-invalid-json" if defect == "invalid-json" else json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", side_effect=request):
                report.guarded("password:scenario", "ownership", lambda: auth.consumer_password_reads(
                    report, SimpleNamespace(required=lambda _: "https://functions.example.invalid"), consumers))
            for secret in ["A-secret-password", "B-secret-password", "A-secret-token", "B-secret-token",
                           "secret-invalid-json"]:
                self.assertNotIn(secret, str(report.checks))
            return report.checks, calls

    def test_six_real_result_and_owner_checks_use_only_verification_endpoint(self):
        checks, calls = self.run_reads()
        self.assertEqual(len(checks), 6)
        self.assertEqual(len(calls), 6)
        self.assertTrue(all(check["status"] == "PASS" for check in checks), checks)
        self.assertEqual(calls, [(7, False), (7, False), (7, True), (8, False), (8, False), (8, True)])

    def test_invalid_or_leaked_results_never_pass_and_stop_remaining_reads(self):
        for defect in ["cross-allowed", "wrong-denial", "non-boolean", "inverted", "server-error", "null", "invalid-json"]:
            with self.subTest(defect=defect):
                checks, calls = self.run_reads(defect)
                self.assertTrue(any(check["status"] in {"FAIL", "BLOCKED"} for check in checks), checks)
                self.assertLess(len(calls), 6)

    def test_two_distinct_positive_integer_owners_required_before_network(self):
        for owners in [[7], [7, 7], [None, 8], [0, 8], [True, 8], ["7", 8]]:
            with self.subTest(owners=owners), tempfile.TemporaryDirectory() as directory:
                with patch.object(auth, "http") as request:
                    with self.assertRaises(auth.EvidenceError):
                        auth.consumer_password_reads(auth.Report(Path(directory)),
                            SimpleNamespace(required=lambda _: "https://functions.example.invalid"),
                            [SimpleNamespace(business_id=owner) for owner in owners])
                    request.assert_not_called()

    def test_current_run_gate_requires_all_thirty_exact_cases_once(self):
        prefix = "ApiFunctions.Tests.PasswordOwnershipTests."
        names = set()
        for operation in ["set", "verify"]:
            for owner in [7, 8]:
                for case in ["Consumer_own_password_reaches_only_signed_owner",
                             "Other_consumer_password_denied_before_any_storage"]:
                    names.add(prefix + f'{case}(owner: {owner}, operation: "{operation}")')
            names.add(prefix + f'Missing_consumer_owner_denied_before_any_storage(operation: "{operation}")')
            for category in ["anonymous", "unknown"]:
                names.add(prefix + f'Untrusted_context_denied_before_any_storage(category: "{category}", operation: "{operation}")')
            for result in ["True", "False"]:
                names.add(prefix + f'Persistence_result_is_not_replaced_with_success(operation: "{operation}", result: {result})')
        for category in ["employee", "manufacturing", "service"]:
            for result in ["True", "False"]:
                names.add(prefix + f'Internal_reset_requires_individual_customer_before_write(category: "{category}", customer: {result})')
                names.add(prefix + f'Internal_verification_is_self_only(category: "{category}", own: {result})')
        self.assertEqual(len(names), 30)
        for defect, expected in [(None, "PASS"), ("missing", "BLOCKED"), ("skipped", "BLOCKED"),
                                 ("duplicate", "BLOCKED"), ("new", "BLOCKED"), ("failed", "FAIL"),
                                 ("absent", "BLOCKED")]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                results = {name: ["Passed"] for name in sorted(names)}
                first = next(iter(results))
                if defect == "missing":
                    results.pop(first)
                elif defect == "skipped":
                    results[first] = ["NotExecuted"]
                elif defect == "duplicate":
                    results[first].append("Passed")
                elif defect == "new":
                    results[prefix + "Unreconciled_case"] = ["Passed"]
                elif defect == "failed":
                    results[first] = ["Failed"]
                elif defect == "absent":
                    results.clear()
                report = auth.Report(Path(directory))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "test-hash"})):
                    auth.password_ownership_evidence(report)
                self.assertEqual(report.checks[0]["status"], expected)


if __name__ == "__main__":
    unittest.main()
