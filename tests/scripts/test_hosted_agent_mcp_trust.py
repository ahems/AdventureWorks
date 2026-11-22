import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "hosted_trust", ROOT / "scripts/utilities/hosted-agent-mcp-trust.py")
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)

SHARED = "3a3f63e6-0000-0000-0000-000000000001"
HOSTED = "3a3f63e6-0000-0000-0000-000000000002"
BLUEPRINT = "3a3f63e6-0000-0000-0000-000000000003"
OTHER = "3a3f63e6-0000-0000-0000-000000000004"
TENANT = "3a3f63e6-0000-0000-0000-000000000005"
SUBSCRIPTION = "3a3f63e6-0000-0000-0000-000000000006"
ENDPOINT = ("https://account.services.ai.azure.com/api/projects/project/agents/"
            "manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1")


def agent(principal=HOSTED, kind="hosted"):
    return {"name": "manufacturing-agent", "versions": {"latest": {
        "definition": {"kind": kind},
        "instance_identity": {"principal_id": principal, "client_id": OTHER},
        "blueprint": {"principal_id": BLUEPRINT},
    }}}


def settings(principals=SHARED, previous_hosted=None):
    values = [{"name": trust.SETTING, "value": principals},
              {"name": "MCP_ENTRA_TENANT_ID", "value": TENANT}]
    if previous_hosted is not None:
        values.append({"name": "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID", "value": previous_hosted})
    return values


class HostedAgentMcpTrustTests(unittest.TestCase):
    def resolve(self, deployed=None, configured=None, runtime=SHARED, endpoint=ENDPOINT):
        responses = [{"principalId": runtime}]
        if endpoint:
            responses.append(agent() if deployed is None else deployed)
        responses.append(settings() if configured is None else configured)
        with patch.object(trust, "azure_json",
                          side_effect=responses) as reads:
            result = trust.resolve_trust(endpoint, "resource-group", "mcp-app",
                                         "runtime-identity", SUBSCRIPTION)
        return result, reads.call_args_list

    def test_discovers_instance_principal_preserves_shared_and_uses_read_only_calls(self):
        result, calls = self.resolve()
        self.assertEqual(result, {"trusted": f"{SHARED},{HOSTED}", "functions": SHARED, "hosted": HOSTED})
        self.assertNotIn(BLUEPRINT, result["trusted"])
        self.assertNotIn(OTHER, result["trusted"])
        self.assertEqual(calls[0].args[0], [
            "identity", "show", "--resource-group", "resource-group", "--name", "runtime-identity",
            "--subscription", SUBSCRIPTION])
        self.assertEqual(calls[1].args[0], [
            "rest", "--method", "get", "--resource", "https://ai.azure.com", "--url",
            "https://account.services.ai.azure.com/api/projects/project/agents/"
            "manufacturing-agent?api-version=2025-11-15-preview", "--subscription", SUBSCRIPTION])
        self.assertEqual(calls[2].args[0][:6],
                         ["containerapp", "show", "--resource-group", "resource-group", "--name", "mcp-app"])

    def test_reruns_are_idempotent_and_preserve_other_explicit_trust(self):
        for configured in (f"{SHARED},{HOSTED},{OTHER}",
                           f"{SHARED}; {HOSTED.upper()} {OTHER},{SHARED}"):
            result, _ = self.resolve(configured=settings(configured))
            self.assertEqual(result["trusted"], f"{SHARED},{HOSTED},{OTHER}")

    def test_identity_rotation_adds_new_principal_without_revoking_existing_trust(self):
        result, _ = self.resolve(deployed=agent(OTHER), configured=settings(f"{SHARED},{HOSTED}"))
        self.assertEqual(result, {"trusted": f"{SHARED},{HOSTED},{OTHER}", "functions": SHARED, "hosted": OTHER})

    def test_identity_rotation_removes_only_the_previously_configured_hosted_principal(self):
        result, _ = self.resolve(deployed=agent(OTHER),
                                 configured=settings(f"{SHARED},{HOSTED},{BLUEPRINT}", HOSTED))
        self.assertEqual(result, {
            "trusted": f"{SHARED},{BLUEPRINT},{OTHER}", "functions": SHARED, "hosted": OTHER,
        })

    def test_absent_hosted_endpoint_clears_its_profile_without_changing_trust(self):
        result, calls = self.resolve(endpoint="", configured=settings(f"{SHARED},{HOSTED}"))
        self.assertEqual(result, {"trusted": f"{SHARED},{HOSTED}", "functions": SHARED, "hosted": ""})
        self.assertEqual(len(calls), 2)

    def test_absent_hosted_endpoint_removes_the_previous_hosted_principal(self):
        result, _ = self.resolve(endpoint="", configured=settings(f"{SHARED},{HOSTED},{OTHER}", HOSTED))
        self.assertEqual(result, {"trusted": f"{SHARED},{OTHER}", "functions": SHARED, "hosted": ""})

    def test_runtime_identity_must_be_trusted_and_distinct_from_hosted(self):
        for runtime, configured, deployed in [
                (OTHER, settings(), agent()),
                (HOSTED, settings(f"{SHARED},{HOSTED}"), agent()),
                ("not-a-uuid", settings(), agent())]:
            with self.subTest(runtime=runtime), self.assertRaises(ValueError):
                self.resolve(runtime=runtime, configured=configured, deployed=deployed)

    def test_missing_or_invalid_identity_never_falls_back_to_blueprint_or_client(self):
        invalid = [agent(None), agent("not-a-uuid"), agent("0" * 32),
                   agent("00000000-0000-0000-0000-000000000000"), agent(kind="prompt"),
                   {}, {"name": "manufacturing-agent", "versions": {}}]
        missing = agent()
        del missing["versions"]["latest"]["instance_identity"]
        invalid.append(missing)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.resolve(deployed=value)

    def test_missing_or_invalid_service_grant_configuration_fails_closed(self):
        for configured in ([], settings(""), settings("not-a-uuid"), settings(None),
                           [{"name": trust.SETTING, "value": SHARED}],
                           [{"name": trust.SETTING, "secretRef": "trust"},
                            {"name": "MCP_ENTRA_TENANT_ID", "value": TENANT}],
                           [None], {}):
            with self.subTest(configured=configured), self.assertRaises(ValueError):
                self.resolve(configured=configured)

    def test_rejects_foreign_or_unexpected_endpoint_before_any_azure_read(self):
        for endpoint in (ENDPOINT.replace("https:", "http:"),
                         ENDPOINT.replace("account.services.ai.azure.com", "attacker.test"),
                         ENDPOINT.replace("/manufacturing-agent/", "/other-agent/"),
                         ENDPOINT.replace("/manufacturing-agent/", "/manufacturing-agent/versions/1/"),
                         ENDPOINT.replace("https://", "https://user:password@"),
                         ENDPOINT + "#fragment"):
            with self.subTest(endpoint=endpoint), patch.object(trust, "azure_json") as read:
                with self.assertRaises(ValueError):
                    trust.resolve_trust(endpoint, "group", "app", "identity", SUBSCRIPTION)
                read.assert_not_called()

    def test_cli_errors_do_not_leak_arbitrary_response_content(self):
        with patch.object(trust.subprocess, "run",
                          return_value=SimpleNamespace(returncode=1, stdout="secret", stderr="token")):
            with self.assertRaises(ValueError) as error:
                trust.azure_json(["rest"])
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("token", str(error.exception))

    def test_cli_reads_use_json_and_capture_output_without_shell(self):
        with patch.object(trust.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(agent()))) as run:
            self.assertEqual(trust.azure_json(["rest", "--method", "get"]), agent())
        self.assertEqual(run.call_args.args[0],
                         ["az", "rest", "--method", "get", "--only-show-errors", "--output", "json"])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_root_hook_wires_trust_before_functions_without_replacing_other_settings(self):
        hook = (ROOT / "scripts/hooks/postdeploy.sh").read_text()
        self.assertIn("principal_profiles=$(python3 scripts/utilities/hosted-agent-mcp-trust.py", hook)
        self.assertIn('redirect_env_pairs+=("MCP_TRUSTED_SERVICE_PRINCIPAL_IDS=$hosted_trust")', hook)
        self.assertIn('redirect_env_pairs+=("MCP_FUNCTIONS_PRINCIPAL_ID=$functions_principal")', hook)
        self.assertIn('redirect_env_pairs+=("MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID=$hosted_principal")', hook)
        self.assertIn('--set-env-vars "${redirect_env_pairs[@]}"', hook)
        self.assertNotIn("--replace-env-vars", hook)
        # Service-scoped deploys must not silently drop the hosted principal from MCP trust.
        published = hook.index('get_azd_value "AGENT_MANUFACTURING_AGENT_RESPONSES_ENDPOINT"')
        fallback = hook.index('manufacturing_endpoint=$(get_azd_value "MANUFACTURING_AGENT_ENDPOINT")')
        self.assertLess(published, fallback)
        self.assertLess(fallback, hook.index("principal_profiles=$(python3"))
        self.assertLess(hook.index('redirect_env_pairs+=("MCP_TRUSTED_SERVICE_PRINCIPAL_IDS='),
                        hook.index("bash scripts/hooks/api-functions-postdeploy.sh"))


if __name__ == "__main__":
    unittest.main()
