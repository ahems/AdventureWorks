import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/hooks/seed-job-execution.sh"


class SeedJobExecutionTests(unittest.TestCase):
    def run_helper(self, execution_name):
        with tempfile.TemporaryDirectory() as directory:
            output_file = Path(directory) / "github-output"
            environment = {
                **os.environ,
                "GITHUB_OUTPUT": str(output_file),
                "TEST_EXECUTION_NAME": execution_name,
            }
            script = f"""
set -e
az() {{
  case "$*" in
    *"job start"*) printf '%s\\n' "$TEST_EXECUTION_NAME" ;;
    *) echo "Unexpected az call: $*" >&2; return 90 ;;
  esac
}}
source "{HELPER}"
start_seed_job demo-seed-job demo-resource-group
"""
            result = subprocess.run(
                ["bash", "-c", script],
                env=environment,
                text=True,
                capture_output=True,
                timeout=10,
            )
            output = output_file.read_text() if output_file.exists() else ""
            return result, output

    def test_seed_start_publishes_exact_execution_to_github_actions(self):
        result, output = self.run_helper("demo-seed-job-abc123")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "seed_execution_name=demo-seed-job-abc123\n")

    def test_invalid_execution_name_is_not_published(self):
        result, output = self.run_helper("valid-name\nmalicious=value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not return an execution name", result.stderr)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
