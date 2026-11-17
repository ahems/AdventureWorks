import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location("sql_entrypoint", Path(__file__).parent / "container/entrypoint.py")
entrypoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entrypoint)
SPEC = importlib.util.spec_from_file_location(
    "runtime_sql", Path(__file__).parents[1] / "scripts/test-runtime-sql.py")
runtime_sql = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_sql)


class SqlPermissionTests(unittest.TestCase):
    def evidence(self):
        ids = ["shared-uami", "sql:identity:current-user:external-client-sid",
               "sql:required-metadata:Production.ProductReview:default-definitions",
               "sql:required-metadata:Production.ProductReview:defaults-present",
               "sql:required-metadata:Production.ProductReview:view-definition",
               "sql:database-execute:database:EXECUTE"]
        ids += ["sql:forbidden-role:" + role + ":membership" for role in [
            "db_owner", "db_securityadmin", "db_accessadmin", "db_ddladmin", "db_backupoperator"]]
        ids += ["sql:required-role:" + role + ":membership" for role in ["db_datareader", "db_datawriter"]]
        ids += ["sql:database-admin:database:" + permission for permission in [
            "CONTROL", "ALTER", "ALTER ANY ROLE", "ALTER ANY USER", "ALTER ANY SCHEMA",
            "CREATE TABLE", "CREATE PROCEDURE", "CREATE FUNCTION", "CREATE VIEW", "CREATE SCHEMA",
            "TAKE OWNERSHIP", "ALTER ANY DATABASE SCOPED CONFIGURATION"]]
        ids += ["sql:inventory:" + kind for kind in [
            "user-impersonate", "schema-admin", "object-admin", "table-data", "routine-execute"]]
        checks = [{"id": name, "group": "sql-effective", "status": "PASS", "detail": "Observed permission."}
                  for name in ids]
        checks.append({"id": "sql:shared-data-access-exception", "group": "sql-effective",
                       "status": "ACCEPTED_EXCEPTION", "detail": "Shared runtime broad data access is explicit."})
        return {"checks": checks}

    def test_exact_complete_sql_evidence_retains_real_pass_fail_and_unknown(self):
        for status, code in [("PASS", 0), ("FAIL", 1), ("BLOCKED", 2)]:
            document = self.evidence()
            document["checks"][0]["status"] = status
            expected = copy.deepcopy(document)
            entrypoint.validate_sql_evidence(document, code)
            self.assertEqual(document, expected)

    def test_every_missing_obligation_duplicate_exit_mismatch_and_unreviewed_exception_blocks(self):
        good = self.evidence()
        defects = []
        for index in range(len(good["checks"])):
            document = copy.deepcopy(good)
            document["checks"].pop(index)
            defects.append(document)
        for defect in ["duplicate", "bad-status", "bad-group", "arbitrary-exception", "empty-detail", "malformed"]:
            document = copy.deepcopy(good)
            if defect == "duplicate":
                document["checks"].append(document["checks"][0])
            elif defect == "bad-status":
                document["checks"][0]["status"] = "SKIP"
            elif defect == "bad-group":
                document["checks"][0]["group"] = "unknown"
            elif defect == "arbitrary-exception":
                document["checks"][0]["status"] = "ACCEPTED_EXCEPTION"
            elif defect == "empty-detail":
                document["checks"][0]["detail"] = ""
            else:
                document["checks"] = ["invalid"]
            defects.append(document)
        for document in defects:
            with self.subTest(document=document):
                entrypoint.validate_sql_evidence(document, 0)
                self.assertEqual(len(document["checks"]), 1)
                self.assertEqual(document["checks"][0]["status"], "BLOCKED")
        for code in [1, 2, 124]:
            document = self.evidence()
            entrypoint.validate_sql_evidence(document, code)
            self.assertEqual(document["checks"][0]["status"], "BLOCKED")

    def test_incomplete_or_contradictory_evidence_cannot_erase_an_observed_failure(self):
        for defect in ["missing", "exit", "duplicate", "malformed"]:
            document = self.evidence()
            document["checks"][0]["status"] = "FAIL"
            if defect == "missing":
                document["checks"].pop()
            elif defect == "duplicate":
                document["checks"].append(document["checks"][0])
            elif defect == "malformed":
                document["checks"].append("invalid")
            entrypoint.validate_sql_evidence(document, 0 if defect == "exit" else 1)
            self.assertEqual(document["checks"][0]["status"], "FAIL")

    def test_existing_runtime_probe_requires_complete_result_and_verified_cleanup(self):
        body = json.dumps(self.evidence(), separators=(",", ":")).encode()
        good = b"# " + body + b"\r\nAUTH_SQL_FINISHED:0:0\r\n"
        document, cleaned = runtime_sql.parse_result(good)
        self.assertEqual(document, self.evidence())
        self.assertTrue(cleaned)
        for ending in [b"", b"AUTH_SQL_FINISHED:0:1\r\n",
                       b"AUTH_SQL_FINISHED:0:0\r\nAUTH_SQL_FINISHED:0:0\r\n"]:
            with self.subTest(ending=ending):
                document, cleaned = runtime_sql.parse_result(b"# " + body + b"\r\n" + ending)
                self.assertFalse(cleaned)
                if not ending or ending.count(b"AUTH_SQL_FINISHED") != 1:
                    self.assertEqual(document["checks"][0]["status"], "BLOCKED")
        for output in [b"", body + b"\n" + body + b"\nAUTH_SQL_FINISHED:0:0\n"]:
            with self.subTest(output=output), self.assertRaises(runtime_sql.auth.EvidenceError):
                runtime_sql.parse_result(output)

    def test_missing_cleanup_marker_cannot_erase_observed_permission_failure(self):
        document = self.evidence()
        document["checks"][0]["status"] = "FAIL"
        output = json.dumps(document, separators=(",", ":")).encode()
        result, cleaned = runtime_sql.parse_result(output)
        self.assertFalse(cleaned)
        self.assertEqual(result["checks"][0]["status"], "FAIL")

    def test_interrupted_runtime_probe_reports_unverified_cleanup(self):
        values = {"SERVICE_API_MCP_NAME": "mcp", "USER_MANAGED_IDENTITY_NAME": "identity",
                  "SQL_SERVER_NAME": "sql", "SQL_DATABASE_NAME": "database"}
        deployment = SimpleNamespace(
            group="group", required=values.__getitem__,
            azure=Mock(side_effect=[
                {"identity": {"userAssignedIdentities": {"identity-id": {}}}},
                {"id": "identity-id", "clientId": "client", "principalId": "principal"},
                {"tenantId": "tenant"},
                {"fullyQualifiedDomainName": "sql.example.invalid"},
            ]),
        )
        report = runtime_sql.auth.Report(Path("."))
        with tempfile.TemporaryDirectory() as build:
            (Path(build) / "PrivateProbe.dll").write_bytes(b"fixture")
            with patch.object(runtime_sql.tempfile, "TemporaryDirectory") as temporary, \
                    patch.object(runtime_sql.auth, "command"), \
                    patch.object(runtime_sql, "execute",
                                 side_effect=runtime_sql.auth.EvidenceError("probe incomplete")):
                temporary.return_value.__enter__.return_value = build
                with self.assertRaises(runtime_sql.auth.EvidenceError):
                    runtime_sql.run(report, deployment)
        self.assertEqual(report.checks[-1]["id"], "runtime-sql:cleanup")
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
