import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "agent_tools", ROOT / "scripts/utilities/agents/lib/build-agent-tools.py")
agent_tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_tools)
FINGERPRINT_SPEC = importlib.util.spec_from_file_location(
    "agent_fingerprint", ROOT / "scripts/utilities/agents/lib/agent-config-fingerprint.py")
agent_fingerprint = importlib.util.module_from_spec(FINGERPRINT_SPEC)
FINGERPRINT_SPEC.loader.exec_module(agent_fingerprint)


class AgentToolConfigurationTests(unittest.TestCase):
    def build(self, mcp_tools="[]", include_dab=False, dab_tools="[]", connection_id=""):
        return agent_tools.build_tools(
            "https://mcp.example.test/mcp",
            "https://dab.example.test/mcp",
            mcp_tools,
            include_dab,
            connection_id,
            dab_tools,
        )

    def test_empty_allow_lists_omit_both_mcp_servers(self):
        self.assertEqual(self.build(), [])

    def test_custom_mcp_has_only_explicitly_allowed_tools_and_dab_is_opt_in(self):
        self.assertEqual(self.build(mcp_tools='["search_products","get_product_details"]'), [{
            "type": "mcp",
            "server_label": "adventureworks_mcp",
            "server_url": "https://mcp.example.test/mcp",
            "require_approval": "never",
            "allowed_tools": ["search_products", "get_product_details"],
        }])

    def test_dab_requires_an_explicit_allow_list(self):
        with self.assertRaisesRegex(ValueError, "explicit non-empty"):
            self.build(include_dab=True)
        self.assertEqual(
            self.build(include_dab=True, dab_tools='["read_record"]', connection_id="dab-connection"),
            [{
                "type": "mcp",
                "server_label": "dabmcp",
                "require_approval": "never",
                "allowed_tools": ["read_record"],
                "project_connection_id": "dab-connection",
            }],
        )

    def test_invalid_or_duplicate_tool_names_fail_closed(self):
        for value in ["{", "{}", '[""]', '["search","search"]', "[null]", '["search products"]']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.build(mcp_tools=value)
        with self.assertRaises(ValueError):
            self.build(mcp_tools='["search"]', include_dab="true")

    def test_server_urls_must_be_https_when_server_is_enabled(self):
        with self.assertRaisesRegex(ValueError, "absolute HTTPS"):
            agent_tools.build_tools("http://mcp.example.test", "", '["search"]', False, "", "[]")
        with self.assertRaisesRegex(ValueError, "absolute HTTPS"):
            agent_tools.build_tools("", "https://user:secret@dab.example.test", "[]",
                                    True, "", '["read_record"]')

    def test_agent_config_fingerprint_is_stable_and_tracks_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "a.sh"
            second = root / "b.py"
            first.write_text("agent one\n")
            second.write_text("agent two\n")

            initial = agent_fingerprint.fingerprint(root, [second, first])
            self.assertEqual(initial, agent_fingerprint.fingerprint(root, [first, second]))
            second.write_text("agent two changed\n")
            self.assertNotEqual(initial, agent_fingerprint.fingerprint(root, [first, second]))

    def test_azd_deploy_hook_updates_definitions_only_when_sources_change(self):
        hook = (ROOT / "scripts/hooks/postdeploy.sh").read_text()
        provision = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertIn('if [[ "$foundry_agent_config_hash" != "$deployed_foundry_agent_config_hash" ]]', hook)
        self.assertIn("bash scripts/utilities/create-foundry-agents.sh", hook)
        self.assertLess(provision.index("create-foundry-agents.sh"),
                        provision.index("azd env refresh --no-prompt"))
        self.assertGreater(provision.index("azd env set FOUNDRY_AGENT_CONFIG_HASH"),
                           provision.index("azd env refresh --no-prompt"))


if __name__ == "__main__":
    unittest.main()
