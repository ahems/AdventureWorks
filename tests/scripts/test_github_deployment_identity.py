import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/azd-up-service-principal.yml").read_text()


def step_script(name, next_name):
    return textwrap.dedent(
        WORKFLOW.split(f"      - name: {name}\n", 1)[1]
        .split("        run: |\n", 1)[1]
        .split(f"\n\n      - name: {next_name}", 1)[0]
    )


VALIDATE_INPUTS = step_script("Validate deployment inputs", "Set up .NET")
VERIFY_PRINCIPAL = step_script(
    "Verify deployment service principal", "Log in to azd with GitHub OIDC"
)
CLIENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OBJECT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
TENANT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
SUBSCRIPTION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd"


class GitHubDeploymentIdentityTests(unittest.TestCase):
    def run_validation(self, response, *, overrides=None, graph_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            az = path / "az"
            az.write_text(
                '#!/bin/sh\n'
                'printf "%s\\n" "$@" > "$AZ_CALL"\n'
                '[ "$GRAPH_FAIL" != true ] || exit 1\n'
                'printf "%s" "$GRAPH_RESPONSE"\n'
            )
            az.chmod(0o755)
            call = path / "call"
            env = {
                **os.environ,
                "PATH": f"{path}:{os.environ['PATH']}",
                "AZ_CALL": str(call),
                "GRAPH_FAIL": "true" if graph_fails else "false",
                "GRAPH_RESPONSE": response,
                "DEPLOYER_CLIENT_ID": CLIENT_ID,
                "DEPLOYER_OBJECT_ID": OBJECT_ID,
                "DEPLOYER_TENANT_ID": TENANT_ID,
                "DEPLOYER_SUBSCRIPTION_ID": SUBSCRIPTION_ID,
                "AZURE_LOCATION": "eastus2",
                "FOUNDRY_LOCATION": "swedencentral",
                **(overrides or {}),
            }
            result = subprocess.run(
                ["bash", "-c", f"{VALIDATE_INPUTS}\n{VERIFY_PRINCIPAL}"],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, call.read_text().splitlines() if call.exists() else []

    def test_application_principal_passes_and_uses_graph_self_lookup(self):
        response = json.dumps({
            "id": OBJECT_ID.upper(),
            "appId": CLIENT_ID.upper(),
            "servicePrincipalType": "Application",
        })
        result, call = self.run_validation(response)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(call, [
            "rest", "--method", "get", "--url",
            f"https://graph.microsoft.com/v1.0/servicePrincipals/{OBJECT_ID}"
            "?$select=id,appId,servicePrincipalType",
            "--output", "json",
        ])

    def test_non_application_mismatched_and_invalid_responses_fail_closed(self):
        valid = {"id": OBJECT_ID, "appId": CLIENT_ID, "servicePrincipalType": "Application"}
        responses = [
            json.dumps({**valid, "servicePrincipalType": "ManagedIdentity"}),
            json.dumps({**valid, "servicePrincipalType": "Legacy"}),
            json.dumps({**valid, "id": TENANT_ID}),
            json.dumps({**valid, "appId": TENANT_ID}),
            json.dumps({**valid, "servicePrincipalType": None}),
            json.dumps({"id": OBJECT_ID, "servicePrincipalType": "Application"}),
            "",
            "not json",
            json.dumps(valid) + "\n" + json.dumps(valid),
        ]
        for response in responses:
            with self.subTest(response=response):
                result, call = self.run_validation(response)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Deployment requires an application service principal", result.stderr)
                self.assertTrue(call)

    def test_graph_lookup_failure_stops_deployment(self):
        result, _ = self.run_validation("", graph_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not read the deployment service principal", result.stderr)

    def test_invalid_guid_is_rejected_before_graph_lookup(self):
        for key in ("DEPLOYER_CLIENT_ID", "DEPLOYER_OBJECT_ID", "DEPLOYER_TENANT_ID",
                    "DEPLOYER_SUBSCRIPTION_ID"):
            with self.subTest(key=key):
                result, call = self.run_validation("", overrides={key: "invalid/id"})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("must be a valid GUID", result.stderr)
                self.assertEqual(call, [])

    def test_verification_runs_after_login_before_provisioning(self):
        self.assertLess(WORKFLOW.index("name: Log in to Azure CLI with GitHub OIDC"),
                        WORKFLOW.index("name: Verify deployment service principal"))
        self.assertLess(WORKFLOW.index("name: Verify deployment service principal"),
                        WORKFLOW.index("name: Provision and deploy with azd"))

    def test_foundry_extension_is_installed_before_deploy(self):
        install = WORKFLOW.index("name: Install Foundry agents azd extension")
        verify = WORKFLOW.index("name: Verify host tools")
        deploy = WORKFLOW.index("name: Provision and deploy with azd")
        self.assertLess(install, verify)
        self.assertLess(verify, deploy)
        self.assertIn("az containerapp --help >/dev/null", WORKFLOW)
        self.assertIn(
            "azd extension install azure.ai.agents --version 1.2.0 --no-prompt",
            WORKFLOW,
        )

    def test_deploy_uses_node_22_without_installing_containerapp_extension(self):
        node_step = WORKFLOW.split("      - name: Set up Node.js\n", 1)[1].split(
            "\n      - name:", 1
        )[0]
        self.assertIn('node-version: "22"', node_step)
        self.assertNotIn("az extension add --name containerapp", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
