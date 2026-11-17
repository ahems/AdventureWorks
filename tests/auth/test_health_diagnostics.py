import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
REQUIRED = {"sql", "blobs", "queues", "tables", "mcp", "mcp-ready", "oauth"}
OPTIONAL = {
    "sql-identity", "blob-identity", "queue-identity", "table-identity", "file-identity",
    "webpubsub-identity", "files", "webpubsub-service", "openai", "foundry",
    "manufacturing-agent", "email", "order-emails", "telemetry",
}


@unittest.skipUnless(shutil.which("bash") and shutil.which("jq"), "Bash and jq are required")
class HealthDiagnosticsScriptTests(unittest.TestCase):
    def run_script(self, checks):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "functions.json").write_text(json.dumps({
                "status": "healthy", "checkedAt": "2026-01-01T00:00:00Z", "checks": checks,
            }))
            (root / "mcp.json").write_text(json.dumps({
                "status": "healthy", "checkedAt": "2026-01-01T00:00:00Z",
                "checks": [{"id": name, "status": "healthy", "message": "ok"} for name in ["sql", "tasks"]],
            }))
            curl = root / "curl"
            curl.write_text("""#!/usr/bin/env python3
import os
from pathlib import Path
import sys

args = sys.argv[1:]
url = next(value for value in args if value.startswith("https://"))
output = Path(args[args.index("-o") + 1]) if "-o" in args else None
if url.endswith("/api/health"):
    output.write_text('{"status":"healthy","timestamp":"2026-01-01T00:00:00Z"}')
elif url.endswith("/health"):
    print("Healthy", end="")
elif url.endswith("/api/health/readiness"):
    output.write_text(Path(os.environ["FUNCTIONS_FIXTURE"]).read_text())
    print("200", end="")
elif url.endswith("/ready"):
    output.write_text(Path(os.environ["MCP_FIXTURE"]).read_text())
    print("200", end="")
else:
    sys.exit(1)
""")
            curl.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "API_FUNCTIONS_URL": "https://functions.example.test",
                "API_MCP_URL": "https://mcp.example.test/mcp",
                "FUNCTIONS_FIXTURE": str(root / "functions.json"),
                "MCP_FIXTURE": str(root / "mcp.json"),
            }
            return subprocess.run(
                ["bash", str(ROOT / "tests/scripts/test-health-diagnostics.sh")],
                env=env, capture_output=True, text=True, timeout=20,
            )

    def checks(self):
        return [{"id": name, "status": "healthy", "message": "ok", "required": name in REQUIRED}
                for name in sorted(REQUIRED | OPTIONAL)]

    def test_accepts_complete_contract_with_optional_identity_failure(self):
        checks = self.checks()
        next(item for item in checks if item["id"] == "blob-identity")["status"] = "timeout"
        result = self.run_script(checks)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_duplicate_extra_and_misclassified_checks(self):
        original = self.checks()
        missing = [item for item in original if item["id"] != "queue-identity"]
        duplicate = copy.deepcopy(original) + [copy.deepcopy(original[0])]
        extra = copy.deepcopy(original) + [{"id": "unreviewed", "status": "healthy",
                                           "message": "ok", "required": False}]
        misclassified = copy.deepcopy(original)
        next(item for item in misclassified if item["id"] == "file-identity")["required"] = True
        unhealthy = copy.deepcopy(original)
        next(item for item in unhealthy if item["id"] == "sql")["status"] = "unhealthy"
        for checks in [missing, duplicate, extra, misclassified, unhealthy]:
            with self.subTest(checks=checks):
                self.assertNotEqual(self.run_script(checks).returncode, 0)


if __name__ == "__main__":
    unittest.main()
