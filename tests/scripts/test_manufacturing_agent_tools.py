from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / "manufacturing-agent/mcp-tools/src/mcp-tools/Program.cs"
REGISTRY = ROOT / "api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs"


class ManufacturingAgentToolTests(unittest.TestCase):
    def test_allowed_tools_match_registered_case_sensitive_mcp_wire_names(self):
        source = PROGRAM.read_text()
        allowed = re.search(r"AllowedTools\s*=\s*\[(.*?)\]", source, re.S).group(1)
        names = re.findall(r'"([^"]+)"', allowed)
        registered = set(re.findall(r'new\("([^"]+)"', REGISTRY.read_text()))
        self.assertEqual(len(names), 20)
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(names) - registered, set())
        self.assertTrue(all(re.fullmatch(r"[a-z]+(?:_[a-z]+)*", name) for name in names))
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


if __name__ == "__main__":
    unittest.main()
