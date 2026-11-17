import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "capacity", Path(__file__).parents[1] / "scripts/diagnose-dab-capacity.py")
capacity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capacity)


def metric(name, values, start=0):
    return {"name": {"value": name}, "timeseries": [{"data": [
        {"timeStamp": f"2026-11-10T12:{minute + start:02d}:00Z", "maximum": value}
        for minute, value in enumerate(values)]}]}


class CapacityTests(unittest.TestCase):
    def test_sustained_pressure_requires_five_consecutive_minutes_in_one_series(self):
        samples = metric("cpu_percent", [80, 90, 85, 90, 80])
        summary = capacity.summarize({"value": [samples]}, ["cpu_percent"])["cpu_percent"]
        self.assertEqual(summary["status"], "REVIEW")
        self.assertEqual(summary["longestHighPressureMinutes"], 5)
        for values in [[80, 90, None, 90, 80], [80, 90, 0, 90, 80], [100, 1, 1, 1, 1]]:
            with self.subTest(values=values):
                samples = metric("cpu_percent", values)
                self.assertEqual(capacity.summarize({"value": [samples]}, ["cpu_percent"])
                                 ["cpu_percent"]["status"], "OBSERVED")

    def test_gaps_and_other_replicas_do_not_manufacture_sustained_pressure(self):
        samples = metric("cpu_percent", [80, 90, 85, 90, 80])
        samples["timeseries"][0]["data"].pop(2)
        samples["timeseries"] += metric("cpu_percent", [100, 100, 100])["timeseries"]
        self.assertEqual(capacity.summarize({"value": [samples]}, ["cpu_percent"])
                         ["cpu_percent"]["status"], "OBSERVED")

    def test_missing_data_is_blocked_and_invalid_metrics_are_not_zero(self):
        for values in [[], [None, None]]:
            summary = capacity.summarize({"value": [metric("cpu_percent", values)]}, ["cpu_percent"])
            self.assertEqual(summary["cpu_percent"]["status"], "BLOCKED")
            self.assertIsNone(summary["cpu_percent"]["peak"])
        for values in [[-1], [float("nan")], [True], ["0"]]:
            with self.subTest(values=values), self.assertRaises(capacity.auth.EvidenceError):
                capacity.summarize({"value": [metric("cpu_percent", values)]}, ["cpu_percent"])
        for items in [[], [metric("foreign", [1])],
                      [metric("cpu_percent", [1]), metric("cpu_percent", [1])]]:
            with self.assertRaises(capacity.auth.EvidenceError):
                capacity.summarize({"value": items}, ["cpu_percent"])

    def test_restart_requires_review_but_scale_to_zero_does_not(self):
        summaries = capacity.summarize({"value": [
            metric("Replicas", [0, 0, 1]), metric("RestartCount", [0, 1, 0])]}, ["Replicas", "RestartCount"])
        self.assertEqual(summaries["Replicas"]["status"], "OBSERVED")
        self.assertEqual(summaries["RestartCount"]["status"], "REVIEW")

    def fixture(self, defect=None):
        calls = []

        def azure(*args):
            calls.append(args)
            if args[:2] == ("resource", "list"):
                return ["selected-insights"]
            if args[:3] == ("monitor", "app-insights", "query"):
                self.assertIn("cloud_RoleName == 'DataApiBuilder'", args[-1])
                self.assertNotIn("data,", args[-1])
                return {"tables": [{"columns": [{"name": key} for key in
                        ["samples", "failed", "maxDurationMs", "p95DurationMs"]],
                        "rows": [[0, 0, None, None] if defect == "no-queries" else
                                 [10, 0, 30000, 50] if defect == "slow-sql" else [10, 0, 80, 50]]}]}
            if args[:3] == ("monitor", "metrics", "list"):
                begin, end = args.index("--metric") + 1, args.index("--start-time")
                names = list(args[begin:end])
                if names == capacity.DAB_METRICS:
                    self.assertIn("podName eq '*'", args)
                if defect == "cli-error" and names == capacity.SQL_METRICS:
                    raise capacity.auth.EvidenceError("az monitor exited 1")
                return {"value": [metric(name, [None] if defect == "missing" else
                                        [90] * 5 if defect == "pressure" else
                                        [0, 0] if name == "RestartCount" else [0, 5]) for name in names]}
            if args[:2] == ("rest", "--method"):
                self.assertEqual(args[2], "get")
                if defect == "pagination":
                    return {"value": [], "nextLink": "private-value-must-not-be-exported"}
                if defect == "index":
                    return [{"properties": {"state": {"currentValue": "Active"},
                                            "implementationDetails": "private-value-must-not-be-exported"}}]
                if defect == "unknown-state":
                    return [{"properties": {"state": {"currentValue": "private-value-must-not-be-exported"}}}]
                return {"value": []}
            self.assertIn(args[:2], {("containerapp", "show"), ("sql", "db")})
            self.assertIn("--query", args)
            return {"minReplicas": 0}

        return SimpleNamespace(
            subscription="subscription", group="selected-group",
            required=lambda key: "selected-" + key.lower(), azure=azure), calls

    def test_collector_is_read_only_scoped_and_explicit_about_blocked_evidence(self):
        for defect, outcome in [(None, "OBSERVED"), ("pressure", "REVIEW"), ("index", "REVIEW"),
                                ("missing", "BLOCKED"), ("cli-error", "BLOCKED"),
                                ("pagination", "BLOCKED"), ("unknown-state", "BLOCKED"),
                                ("no-queries", "BLOCKED"), ("slow-sql", "REVIEW")]:
            with self.subTest(defect=defect):
                deployment, calls = self.fixture(defect)
                report = capacity.collect(deployment, 6)
                self.assertEqual(report["outcome"], outcome)
                self.assertNotIn("private-value-must-not-be-exported", json.dumps(report))
                self.assertEqual(len(calls), 8)
                self.assertTrue(all(any("selected-group" in value for value in call) for call in calls))
                self.assertIn("Query Store", " ".join(report["limitations"]))

    def test_command_persists_private_report_and_returns_diagnostic_outcome(self):
        for defect, code in [(None, 0), ("pressure", 1), ("cli-error", 2)]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                deployment, _ = self.fixture(defect)
                with patch.object(capacity.auth, "Deployment", return_value=deployment), \
                        patch.object(capacity.auth, "ROOT", Path(directory)), patch("builtins.print"):
                    self.assertEqual(capacity.main([]), code)
                path, = Path(directory).glob(".auth-results/dab-capacity-*/report.json")
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
                self.assertIn("outcome", json.loads(path.read_text()))


if __name__ == "__main__":
    unittest.main()
