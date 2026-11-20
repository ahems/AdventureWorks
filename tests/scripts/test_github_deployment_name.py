import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/azd-up-service-principal.yml").read_text()
SELECT_NAME = textwrap.dedent(
    WORKFLOW.split("      - name: Select environment name\n", 1)[1]
    .split("        run: |\n", 1)[1]
    .split("\n\n  deploy:", 1)[0]
)
CONFIGURE_ENVIRONMENT = textwrap.dedent(
    WORKFLOW.split("      - name: Configure azd environment\n", 1)[1]
    .split("        run: |\n", 1)[1]
    .split("\n\n      - name: Provision and deploy with azd", 1)[0]
)


class GitHubDeploymentNameTests(unittest.TestCase):
    def run_selection(self, name="", number="1", fail=False):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            shuf = path / "shuf"
            shuf.write_text(
                '#!/bin/sh\n'
                '[ "$*" = "-i 1-999 -n 1" ] || exit 1\n'
                '[ "$SHUF_FAIL" != true ] || exit 1\n'
                'printf "%s\\n" "$SHUF_NUMBER"\n'
            )
            shuf.chmod(0o755)
            output = path / "output"
            result = subprocess.run(
                ["bash", "-c", SELECT_NAME],
                env={
                    **os.environ,
                    "PATH": f"{path}:{os.environ['PATH']}",
                    "ENVIRONMENT_NAME": name,
                    "GITHUB_OUTPUT": str(output),
                    "SHUF_NUMBER": number,
                    "SHUF_FAIL": "true" if fail else "false",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, output.read_text() if output.exists() else ""

    def test_generated_names_include_zero_padded_range_boundaries(self):
        for number, expected in (
            ("1", "adventureworks001"),
            ("123", "adventureworks123"),
            ("999", "adventureworks999"),
        ):
            with self.subTest(number=number):
                result, output = self.run_selection(number=number)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output, f"environment_name={expected}\n")
                self.assertIn(expected, result.stdout)

    def test_generated_name_configures_prefixed_resource_group(self):
        for number in ("1", "123", "999"):
            with self.subTest(number=number), tempfile.TemporaryDirectory() as directory:
                result, output = self.run_selection(number=number)
                self.assertEqual(result.returncode, 0, result.stderr)
                name = output.strip().removeprefix("environment_name=")
                path = Path(directory)
                log = path / "calls"
                for command in ("az", "azd"):
                    executable = path / command
                    executable.write_text(
                        f'#!/bin/sh\nprintf "{command} %s\\n" "$*" >> "$CALL_LOG"\n'
                        + ('printf "false\\n"\n' if command == "az" else "")
                    )
                    executable.chmod(0o755)
                result = subprocess.run(
                    ["bash", "-c", CONFIGURE_ENVIRONMENT],
                    env={
                        **os.environ,
                        "PATH": f"{path}:{os.environ['PATH']}",
                        "CALL_LOG": str(log),
                        "ENVIRONMENT_NAME": name,
                        "DEPLOYER_SUBSCRIPTION_ID": "subscription",
                        "DEPLOYER_CLIENT_ID": "client",
                        "DEPLOYER_OBJECT_ID": "principal",
                        "DEPLOYER_TENANT_ID": "tenant",
                        "AZURE_LOCATION": "eastus2",
                        "FOUNDRY_LOCATION": "swedencentral",
                    },
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = log.read_text()
                self.assertIn(
                    f"az group exists --name rg-{name} --subscription subscription\n",
                    calls,
                )
                self.assertIn(
                    f"azd env set AZURE_RESOURCE_GROUP rg-{name} --no-prompt\n",
                    calls,
                )

    def test_explicit_name_is_preserved_and_invalid_name_is_rejected(self):
        result, output = self.run_selection(name="my-demo", fail=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "environment_name=my-demo\n")

        result, output = self.run_selection(name="invalid name")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Environment name must be", result.stderr)
        self.assertEqual(output, "")

    def test_random_generation_failure_stops_selection(self):
        result, output = self.run_selection(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not generate an environment name", result.stderr)
        self.assertEqual(output, "")

    def test_deploy_uses_selected_name_for_lock_and_all_resource_group_steps(self):
        self.assertIn("environment_name: ${{ steps.select_name.outputs.environment_name }}", WORKFLOW)
        self.assertIn("group: azd-up-${{ needs.prepare.outputs.environment_name }}", WORKFLOW)
        self.assertIn("ENVIRONMENT_NAME: ${{ needs.prepare.outputs.environment_name }}", WORKFLOW)
        self.assertEqual(
            WORKFLOW.count("RESOURCE_GROUP: ${{ needs.prepare.outputs.environment_name }}"),
            2,
        )


if __name__ == "__main__":
    unittest.main()
