"""Offline tests for selected-trace Azure Monitor metadata verification."""

import importlib.util
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "observability", Path(__file__).with_name("test-observability.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
TRACE = "a" * 32


def spans():
    return [
        {"OperationId": TRACE, "Id": "1" * 16, "ParentId": "0" * 16,
         "AppRoleName": "api-functions", "Signal": "request", "Success": True},
        {"OperationId": TRACE, "Id": "2" * 16, "ParentId": "1" * 16,
         "AppRoleName": "api-functions", "Signal": "dependency", "Success": True,
         "GenAiOperation": "invoke_agent"},
    ]


class VerificationTests(unittest.TestCase):
    def test_known_parent_and_gen_ai_are_verified_without_exporting_content(self):
        rows = spans()
        rows[0]["SecretContent"] = "must-not-appear"
        result = verifier.verify_trace_metadata(rows, [TRACE], ["api-functions"], True)[0]
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["linkedSpanCount"], 1)
        self.assertNotIn("SecretContent", str(result))
        self.assertNotIn("must-not-appear", str(result))

    def test_missing_roles_broken_links_and_duplicate_spans_fail(self):
        for rows, roles in [
                ([], []),
                (spans(), ["DataApiBuilder"]),
                ([{**row, "ParentId": "f" * 16} for row in spans()], []),
                (spans() + [spans()[0]], []),
                ([{**row, "ParentId": row["Id"]} for row in spans()], []),
                ([{**spans()[0], "Id": "0" * 16}, spans()[1]], []),
                ([{**row, "Id": "invalid"} for row in spans()], [])]:
            with self.subTest(rows=rows, roles=roles):
                self.assertEqual(verifier.verify_trace_metadata(rows, [TRACE], roles)[0]["status"], "FAIL")

    def test_shared_trace_id_is_not_parent_correlation_proof(self):
        result = verifier.verify_trace_metadata(
            [{**row, "ParentId": "f" * 16} for row in spans()], [TRACE])[0]
        self.assertFalse(result["checks"]["parentLinkObserved"])

    def test_query_is_bounded_and_rejects_injection(self):
        query = verifier.trace_query([TRACE])
        self.assertIn("take 2000", query)
        self.assertIn("ago(1h)", query)
        self.assertNotIn("Message", query)
        for ids in [[], ["x'; AppTraces"], ["0" * 32], [TRACE] * 21]:
            with self.assertRaises(ValueError):
                verifier.trace_query(ids)

    def test_cli_rows_and_table_envelopes_parse_but_malformed_rows_fail(self):
        self.assertEqual(verifier.query_rows(spans()), spans())
        table = {"tables": [{"columns": [{"name": "OperationId"}, {"name": "Id"}],
                             "rows": [[TRACE, "1" * 16]]}]}
        self.assertEqual(verifier.query_rows(table), [{"OperationId": TRACE, "Id": "1" * 16}])
        table["tables"][0]["rows"][0].append("extra")
        with self.assertRaises(ValueError):
            verifier.query_rows(table)

    def test_truncated_query_cannot_claim_complete_evidence(self):
        result = verifier.verify_trace_metadata(spans() * 1000, [TRACE])[0]
        self.assertFalse(result["checks"]["completeQuery"])
        self.assertEqual(result["status"], "FAIL")

    def test_cli_persists_verdict_and_never_prints_query_payload(self):
        for response, code, status in [
                (subprocess.CompletedProcess([], 0, json.dumps(spans()), ""), 0, "PASS"),
                (subprocess.CompletedProcess([], 0, "[]", ""), 1, "FAIL"),
                (subprocess.CompletedProcess([], 1, "", "sensitive diagnostic"), 2, "BLOCKED")]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "evidence.json"
                arguments = ["test-observability.py", "--workspace-id",
                             "12345678-1234-1234-1234-123456789abc",
                             "--trace-id", TRACE, "--output", str(output)]
                stream = io.StringIO()
                with patch("sys.argv", arguments), \
                        patch.object(verifier.subprocess, "run", return_value=response) as query, \
                        contextlib.redirect_stdout(stream):
                    self.assertEqual(verifier.main(), code)
                self.assertEqual(json.loads(output.read_text())["status"], status)
                self.assertNotIn("sensitive diagnostic", output.read_text())
                self.assertNotIn(TRACE, stream.getvalue())
                command = query.call_args.args[0]
                self.assertEqual(command[:4], ["az", "monitor", "log-analytics", "query"])
                self.assertEqual(query.call_args.kwargs["timeout"], 60)


if __name__ == "__main__":
    unittest.main()
