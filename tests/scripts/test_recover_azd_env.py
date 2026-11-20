"""Offline tests for scripts/utilities/recover-azd-env.py."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("recover_azd_env", ROOT / "scripts/utilities/recover-azd-env.py")
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)

ENV = "adventureworks042"
SUB = "00000000-0000-0000-0000-000000000001"
TENANT = "00000000-0000-0000-0000-000000000002"


def deployment(name, timestamp, state="Succeeded", environment=ENV, api_url="https://api.example/graphql/"):
    return {
        "name": name,
        "properties": {
            "provisioningState": state,
            "timestamp": timestamp,
            "parameters": {
                "environmentName": {"value": environment},
                "aadAdminObjectId": {"value": "sp-object-id"},
                "chatGptModelName": {"value": "gpt-4.1"},
                "deployerPrincipalType": {"value": "ServicePrincipal"},
                "restoreOpenAi": {"value": False},
                "foundryname": {"value": ""},
            },
            "outputs": {
                "API_URL": {"type": "String", "value": api_url},
                "API_FUNCTIONS_URL": {"type": "String", "value": "https://func.example"},
                "API_MCP_URL": {"type": "String", "value": "https://mcp.example/mcp"},
                "SERVICE_API_FUNCTIONS_NAME": {"type": "String", "value": "av-func-abc"},
                "AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN": {"type": "String", "value": "swa-secret"},
                "HIDDEN": {"type": "SecureString", "value": "secret"},
                "chatGptDeploymentName": {"type": "String", "value": "chat"},
            },
        },
    }


class FakeCli:
    def __init__(self, deployments=None, environments=(), settings=None, tags=None):
        self.deployments = deployments if deployments is not None else [
            {"name": "module", "properties": {
                "provisioningState": "Succeeded", "timestamp": "2026-11-03T00:00:00Z",
                "parameters": {"environmentName": {"value": ENV}}, "outputs": {"apiUrl": {"value": "x"}}}},
            deployment("old", "2026-11-01T00:00:00Z", api_url="https://old.example/graphql/"),
            deployment("failed", "2026-11-04T00:00:00Z", state="Failed"),
            deployment("latest", "2026-11-02T00:00:00Z"),
        ]
        self.environments = environments
        self.settings = settings if settings is not None else [
            {"name": "AI_AGENT_CHAT_ID", "value": "chat-agent:3"},
            {"name": "AI_AGENT_REVIEW_ID", "value": ""},
            {"name": "MANUFACTURING_AGENT_ENDPOINT", "value": "https://agent.example"},
            {"name": "SQL_CONNECTION_STRING", "value": "do-not-copy"},
        ]
        self.tags = tags if tags is not None else {"azd-env-name": ENV}
        self.commands = []

    def run(self, command):
        self.commands.append(command)
        joined = " ".join(command)
        if joined.startswith("azd env list"):
            return json.dumps([{"Name": name} for name in self.environments])
        if joined.startswith("az account show") and "tenantId" in joined:
            return TENANT + "\n"
        if joined.startswith("az account show"):
            return SUB + "\n"
        if joined.startswith("az group show"):
            return json.dumps({"location": "eastus2", "tags": self.tags})
        if joined.startswith("az deployment group list"):
            return json.dumps(self.deployments)
        if joined.startswith("az functionapp config appsettings list"):
            return json.dumps(self.settings)
        if joined.startswith("azd env new") or joined.startswith("azd env set"):
            return ""
        raise AssertionError(f"Unexpected command: {joined}")

    def written(self):
        return {c[3]: c[4] for c in self.commands if c[:3] == ["azd", "env", "set"]}


def invoke(cli, *argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(recover, "run", cli.run), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = recover.main(["--environment", ENV, *argv])
    return code, stdout.getvalue(), stderr.getvalue()


class RecoverAzdEnvTests(unittest.TestCase):
    def test_writes_latest_root_deployment_values(self):
        cli = FakeCli()
        code, _, _ = invoke(cli)
        self.assertEqual(code, 0)
        values = cli.written()
        self.assertEqual(values["API_URL"], "https://api.example/graphql/")
        self.assertEqual(values["VITE_API_URL"], values["API_URL"])
        self.assertEqual(values["VITE_API_FUNCTIONS_URL"], "https://func.example")
        self.assertEqual(values["AZURE_RESOURCE_GROUP"], f"rg-{ENV}")
        self.assertEqual(values["AZURE_SUBSCRIPTION_ID"], SUB)
        self.assertEqual(values["AZURE_LOCATION"], "eastus2")
        self.assertEqual(values["TENANT_ID"], TENANT)
        self.assertEqual(values["OBJECT_ID"], "sp-object-id")
        self.assertEqual(values["DEPLOYER_PRINCIPAL_TYPE"], "ServicePrincipal")
        self.assertEqual(values["chatGptModelName"], "gpt-4.1")
        self.assertEqual(values["chatGptDeploymentName"], "chat")
        self.assertEqual(values["AI_AGENT_CHAT_ID"], "chat-agent:3")
        self.assertEqual(values["MANUFACTURING_AGENT_ENDPOINT"], "https://agent.example")
        for excluded in ("AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN", "HIDDEN", "SQL_CONNECTION_STRING",
                         "AI_AGENT_REVIEW_ID", "AZURE_OPENAI_ACCOUNT_NAME", "FOUNDRY_AGENT_CONFIG_HASH"):
            self.assertNotIn(excluded, values)
        new = next(c for c in cli.commands if c[:3] == ["azd", "env", "new"])
        self.assertEqual(new[3], ENV)

    def test_dry_run_and_skip_app_settings_write_nothing(self):
        cli = FakeCli()
        code, out, _ = invoke(cli, "--dry-run", "--skip-app-settings")
        self.assertEqual(code, 0)
        self.assertIn("Dry run", out)
        self.assertNotIn("swa-secret", out)
        self.assertFalse(any(c[:2] == ["azd", "env"] and c[2] in ("new", "set") for c in cli.commands))
        self.assertFalse(any("functionapp" in c for c in cli.commands))

    def test_refuses_existing_local_environment(self):
        cli = FakeCli(environments=[ENV])
        code, _, err = invoke(cli)
        self.assertEqual(code, 1)
        self.assertIn("already exists", err)
        self.assertEqual(len(cli.commands), 1)

    def test_rejects_resource_group_of_another_environment(self):
        code, _, err = invoke(FakeCli(tags={"azd-env-name": "adventureworks999"}))
        self.assertEqual(code, 1)
        self.assertIn("belongs to azd environment", err)

    def test_fails_without_matching_successful_deployment(self):
        cli = FakeCli(deployments=[deployment("failed", "2026-11-04T00:00:00Z", state="Failed"),
                                   deployment("other", "2026-11-04T00:00:00Z", environment="other")])
        code, _, err = invoke(cli)
        self.assertEqual(code, 1)
        self.assertIn("No successful main.bicep deployment", err)
        self.assertFalse(cli.written())

    def test_fails_when_required_output_missing(self):
        cli = FakeCli(deployments=[deployment("latest", "2026-11-02T00:00:00Z", api_url="")])
        code, _, err = invoke(cli)
        self.assertEqual(code, 1)
        self.assertIn("API_URL", err)
        self.assertFalse(any(c[:3] == ["azd", "env", "new"] for c in cli.commands))

    def test_parameter_map_covers_defaulted_placeholders(self):
        mapping = recover.parameter_env_map()
        self.assertEqual(mapping["aadAdminObjectId"], "OBJECT_ID")
        self.assertEqual(mapping["deployerPrincipalType"], "DEPLOYER_PRINCIPAL_TYPE")
        self.assertEqual(mapping["embeddingModelName"], "embeddingDeploymentModelName")
        self.assertNotIn("restoreOpenAi", mapping)


if __name__ == "__main__":
    unittest.main()
