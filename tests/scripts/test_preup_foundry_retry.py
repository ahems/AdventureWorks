"""preup must recover from a transient Foundry account create failure without manual repair."""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

PREUP = Path(__file__).resolve().parents[2] / "scripts/hooks/preup.sh"

# Stub az: "create" pops the next scripted outcome; "show" reports the resulting state.
STUB_AZ = r"""#!/usr/bin/env bash
state_file="$STUB_DIR/state"; plan_file="$STUB_DIR/plan"
echo "$*" >> "$STUB_DIR/calls"
case "$2 $3" in
  "account create")
    outcome=$(head -n1 "$plan_file"); sed -i 1d "$plan_file"
    echo "$outcome" > "$state_file"
    [[ "$outcome" == Succeeded ]] && exit 0
    echo "ERROR: (InternalServerError) Internal Server Error." >&2; exit 1 ;;
  "account show")
    [[ -s "$state_file" ]] || exit 3
    if [[ "$*" == *provisioningState* ]]; then cat "$state_file";
    elif [[ "$*" == *allowProjectManagement* ]]; then echo true;
    else echo swedencentral; fi ;;
esac
"""


def ensure_function():
    text = PREUP.read_text()
    match = re.search(r"^ensure_foundry_account\(\) \{.*?^\}\n", text, re.S | re.M)
    return match.group(0)


class FoundryAccountCreateRetryTests(unittest.TestCase):
    def run_ensure(self, plan, initial_state=""):
        with tempfile.TemporaryDirectory() as tmp:
            stub_dir = Path(tmp)
            (stub_dir / "az").write_text(STUB_AZ)
            (stub_dir / "az").chmod(0o755)
            (stub_dir / "plan").write_text("".join(f"{line}\n" for line in plan))
            (stub_dir / "state").write_text(initial_state)
            script = "set -euo pipefail\n" + "\n".join(
                f"{name}() {{ echo \"$1\"; }}" for name in
                ("color_green", "color_yellow", "color_red", "color_dark_gray")
            ) + "\n" + ensure_function() + 'ensure_foundry_account sub rg acct swedencentral\n'
            env = {**os.environ, "PATH": f"{stub_dir}:{os.environ['PATH']}",
                   "STUB_DIR": str(stub_dir), "FOUNDRY_CREATE_RETRY_DELAY": "0"}
            result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=30)
            calls = (stub_dir / "calls").read_text().splitlines()
            return result, sum("account create" in call for call in calls)

    def test_transient_create_failure_is_retried(self):
        result, creates = self.run_ensure(["Failed", "Succeeded"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(creates, 2)

    def test_persistent_failure_stops_after_three_attempts(self):
        result, creates = self.run_ensure(["Failed", "Failed", "Failed"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(creates, 3)
        self.assertIn("after 3 attempts", result.stdout)

    def test_account_left_failed_by_an_earlier_run_is_recreated(self):
        result, creates = self.run_ensure(["Succeeded"], initial_state="Failed\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(creates, 1)

    def test_healthy_existing_account_is_not_recreated(self):
        result, creates = self.run_ensure([], initial_state="Succeeded\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(creates, 0)


if __name__ == "__main__":
    unittest.main()
