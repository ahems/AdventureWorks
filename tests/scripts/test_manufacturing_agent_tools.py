import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / "manufacturing-agent/mcp-tools/src/mcp-tools/Program.cs"
AUTHENTICATION = ROOT / "manufacturing-agent/mcp-tools/src/mcp-tools/McpServiceAuthentication.cs"
REGISTRY = ROOT / "api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs"
SCOPES = ROOT / "api-mcp/AdventureWorks/Auth/OAuthScopes.cs"
TRIGGER = ROOT / "api-functions/Functions/ManufacturingAgentQueueTrigger.cs"
SERVICE_POLICY = ROOT / "api-mcp/AdventureWorks/Auth/ServicePrincipalPolicy.cs"


class ManufacturingAgentToolTests(unittest.TestCase):
    def test_allowed_tools_match_registered_case_sensitive_mcp_wire_names(self):
        source = AUTHENTICATION.read_text()
        read_tools = re.search(r"ReadTools\s*=\s*\[(.*?)\]", source, re.S).group(1)
        autonomous_tools = re.search(r'"FullyAutonomous"\s*=>\s*\[\.\.\s*ReadTools,(.*?)\]', source, re.S).group(1)
        reads = re.findall(r'"([^"]+)"', read_tools)
        writes = re.findall(r'"([^"]+)"', autonomous_tools)
        names = reads + writes
        policies = dict(re.findall(r'new\("([^"]+)",\s*OAuthScopes\.(\w+)', REGISTRY.read_text()))
        scope_values = dict(re.findall(r'public const string (\w+)\s*=\s*"([^"]+)"', SCOPES.read_text()))
        requested = re.findall(r'"([^"]+)"', re.search(r"ReadScopes\s*=\s*\[(.*?)\]", source, re.S).group(1))
        self.assertEqual(len(names), 20)
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(names) - policies.keys(), set())
        self.assertTrue(all(re.fullmatch(r"[a-z]+(?:_[a-z]+)*", name) for name in names))
        self.assertTrue(all(scope_values[policies[name]] in requested for name in reads))
        self.assertTrue(all(scope_values[policies[name]].endswith(".read") for name in reads))
        self.assertTrue(all(policies[name] == "ManufacturingWrite" for name in writes))
        self.assertIn("AllowedTools = McpServiceAuthentication.GetToolsForMode(mode)", PROGRAM.read_text())
        self.assertIn("CreateMcpTool(authorization, mode)", PROGRAM.read_text())
        self.assertIn('$"Mode={mode} ({(int)mode})\\n"', TRIGGER.read_text())
        self.assertIn("get_order_details", names)
        self.assertIn("check_inventory_availability", names)
        self.assertIn("get_production_feasibility", names)
        self.assertIn("begin_manufacturing_run", names)
        self.assertIn("place_supply_order", names)

    def test_instructions_refer_to_wire_names_not_csharp_method_names(self):
        instructions = PROGRAM.read_text().split('const string instructions = """', 1)[1].split('""";', 1)[0]
        for name in ("get_order_details", "check_inventory_availability",
                     "get_production_feasibility", "get_supply_chain_vendors",
                     "get_supply_quote", "begin_manufacturing_run", "place_supply_order"):
            self.assertIn(name, instructions)
        for name in ("GetOrderDetails", "CheckInventoryAvailability", "GetProductionFeasibility",
                     "GetSupplyChainVendors", "GetSupplyQuote", "BeginManufacturingRun",
                     "PlaceSupplyOrder", "StopManufacturing"):
            self.assertNotIn(name, instructions)
        self.assertIn('{"error":{"code":"tool_failure"}}', instructions)

    def test_server_profiles_match_hosted_and_functions_agent_tool_definitions(self):
        source = SERVICE_POLICY.read_text()

        def block(profile):
            block = re.search(rf"private static readonly Policy {profile} = new\((.*?)\n\s*\}}\);",
                              source, re.S)
            self.assertIsNotNone(block)
            return block.group(1)

        def tools(profile):
            return set(re.findall(r'"([^"]+)"', block(profile)))

        hosted_source = AUTHENTICATION.read_text()
        read_tools = re.search(r"ReadTools\s*=\s*\[(.*?)\]", hosted_source, re.S).group(1)
        action_tools = re.search(r'"FullyAutonomous"\s*=>\s*\[\.\.\s*ReadTools,(.*?)\]',
                                 hosted_source, re.S).group(1)
        self.assertEqual(tools("HostedManufacturing"), set(re.findall(r'"([^"]+)"', read_tools + action_tools)))

        defined = set()
        for filename in ("admin-order-agent.sh", "admin-customer-agent.sh", "eshop-help-me-choose-agent.sh"):
            script = (ROOT / "scripts/utilities/agents" / filename).read_text()
            match = re.search(r"^ALLOWED_TOOLS='(\[.*\])'$", script, re.MULTILINE)
            self.assertIsNotNone(match, filename)
            defined.update(json.loads(match.group(1)))
        self.assertEqual(tools("Functions"), defined)

        scope_values = dict(re.findall(r'public const string (\w+)\s*=\s*"([^"]+)"', SCOPES.read_text()))
        server_scopes = lambda profile: {
            scope_values[name] for name in re.findall(r"OAuthScopes\.(\w+)", block(profile))
        }
        requested = set(re.findall(r'"([^"]+)"',
                                   re.search(r"ReadScopes\s*=\s*\[(.*?)\]", hosted_source, re.S).group(1)))
        self.assertEqual(server_scopes("HostedManufacturing"), requested | {"manufacturing.write"})

        provider = (ROOT / "api-functions/Services/McpServiceTokenProvider.cs").read_text()
        provider_values = dict(re.findall(r'public const string (\w+Scope)\s*=\s*"([^"]+)"', provider))
        functions_scopes = {"mcp.access"}
        for filename in ("OrderGenerationAgentService.cs", "CustomerGenerationAgentService.cs",
                         "HelpMeChooseService.cs"):
            service = (ROOT / "api-functions/Services" / filename).read_text()
            functions_scopes.update(provider_values[name]
                                    for name in re.findall(r"McpServiceTokenProvider\.(\w+Scope)", service))
        self.assertEqual(server_scopes("Functions"), functions_scopes)


if __name__ == "__main__":
    unittest.main()
