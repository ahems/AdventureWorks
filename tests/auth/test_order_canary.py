import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import order_canary  # noqa: E402
import validate as auth  # noqa: E402

SAFE = ([], {"processingToApprovedMinMinutes": 5}, {"isEnabled": False},
        {"isRunning": False, "queueDepth": 0}, {"mode": 0, "isAgentActive": False})


def canary():
    values = {"API_FUNCTIONS_URL": "https://functions.example.invalid", "API_URL": "https://dab.example.invalid/graphql/",
              "API_MCP_URL": "https://mcp.example.invalid/mcp", "SERVICE_API_FUNCTIONS_NAME": "func"}
    deployment = SimpleNamespace(values=values, group="rg", required=lambda key: values[key], runtime=None)
    report = auth.Report(Path(tempfile.mkdtemp()))
    return order_canary.OrderCanary(report, deployment, "run0123456789abc"), report


class PreflightTests(unittest.TestCase):
    def test_safe_configuration_has_no_blockers(self):
        self.assertEqual(order_canary.preflight_blockers(*SAFE), [])
        self.assertEqual(order_canary.preflight_blockers(["false"], *SAFE[1:]), [])

    def test_each_unsafe_gate_blocks(self):
        cases = [
            (0, ["true"]), (0, ["a", "b"]), (0, None),
            (1, {"processingToApprovedMinMinutes": 0}), (1, {}),
            (2, {"isEnabled": True}), (2, {}),
            (3, {"isRunning": True, "queueDepth": 0}), (3, {"isRunning": False, "queueDepth": 3}),
            (4, {"mode": 1, "isAgentActive": False}), (4, {"mode": 0, "isAgentActive": True}), (4, None),
        ]
        for index, value in cases:
            arguments = list(SAFE)
            arguments[index] = value
            with self.subTest(index=index, value=value):
                self.assertTrue(order_canary.preflight_blockers(*arguments))

    def test_cancellation_window_and_store_and_telemetry_rules(self):
        self.assertTrue(order_canary.within_window(299.0, 5))
        self.assertFalse(order_canary.within_window(300, 5))
        self.assertFalse(order_canary.within_window(-1, 5))
        address = [{"AddressID": 1}]
        self.assertTrue(order_canary.safe_store([{"CustomerID": 1, "PersonID": None}], address))
        self.assertFalse(order_canary.safe_store([{"CustomerID": 1, "PersonID": 7}], address))
        self.assertFalse(order_canary.safe_store([], address))
        self.assertFalse(order_canary.safe_store([{"CustomerID": 1, "PersonID": None}], []))
        self.assertEqual(order_canary.telemetry_outcome(1, 0), "PASS")
        self.assertEqual(order_canary.telemetry_outcome(0, 0), "BLOCKED")
        self.assertEqual(order_canary.telemetry_outcome(1, 1), "FAIL")
        self.assertEqual(order_canary.telemetry_outcome(None, 0), "BLOCKED")


class RunTests(unittest.TestCase):
    def run_with(self, simulator, allow):
        instance, report = canary()
        reads = {"orders/pipeline/config": SAFE[1], "auto-promotion/config": SAFE[2],
                 "shopping-simulator/status": simulator, "manufacturing/agent-config": SAFE[4]}
        instance.deployment.azure = lambda *args: []
        with patch.object(instance, "function_get", side_effect=reads.__getitem__), \
                patch.object(auth, "http", side_effect=AssertionError("no order request expected")):
            instance.run(allow)
        return {check["id"]: check["status"] for check in report.checks}

    def test_unsafe_preflight_sends_no_order(self):
        checks = self.run_with({"isRunning": True, "queueDepth": 0}, True)
        self.assertEqual(checks, {"order:preflight": "BLOCKED"})

    def test_orders_require_explicit_opt_in(self):
        checks = self.run_with(SAFE[3], False)
        self.assertEqual(checks, {"order:preflight": "PASS", "order:creation": "BLOCKED"})

    def test_generated_order_failure_is_classified_on_its_own_trace(self):
        import agent_sweep
        instance, report = canary()
        trace = "c" * 32

        def generation(report, deployment, label, agent_key, policy, tools, request):
            return request(f"00-{trace}-{'d' * 16}-01")

        with patch.object(instance, "internal", return_value="token"), \
                patch.object(auth, "http", return_value=(500, {}, b'{"success": false}')), \
                patch.object(agent_sweep, "service_generation_canary", side_effect=generation), \
                patch.object(auth, "foundry_throttled", return_value=True) as throttled, \
                patch.object(instance, "admin_cancel") as cancel:
            instance.order_generation(SimpleNamespace(customer_id=7), 5)
        throttled.assert_called_once_with(instance.deployment, trace, sleep=unittest.mock.ANY)
        cancel.assert_not_called()
        self.assertEqual(report.checks[0]["status"], "BLOCKED")
        self.assertEqual(report.inventory["orderCanaryResiduals"][0]["state"], "uncertain")

    def test_failed_post_create_checks_still_cancel(self):
        instance, report = canary()

        def fail():
            raise auth.EvidenceError("denial probe failed")

        with patch.object(instance, "admin_cancel") as cancel:
            instance.guarded_then_cancel("storefront", 42, 0.0, 5, fail)
        cancel.assert_called_once_with(42, "storefront", 0.0, 5)
        self.assertEqual(report.checks[0]["status"], "BLOCKED")

    def test_cancellation_flag_requires_order_profile(self):
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            auth.main(["--offline", "--order-cancellation-canary"])


class McpOwnershipTests(unittest.TestCase):
    ORDER, OWNER, FOREIGN = 42, 7, 8

    def server(self, leak=False):
        def respond(url, tool, token, arguments, request_id):
            caller = int(token)
            if "customerId" in arguments and arguments["customerId"] != caller and not leak:
                return True, ["You can only access your own records."]
            customer = arguments.get("customerId", caller)
            if tool == "get_customer_orders":
                if customer != self.OWNER:
                    return False, [f"No orders found for customer #{customer}."]
                return False, [f"History\nCustomerID: {customer}\nRecent\n\nOrder #{self.ORDER}\n  Status\n"]
            if tool == "get_order_details":
                if customer != self.OWNER:
                    return False, [f"Order #{self.ORDER} does not belong to customer #{customer}."]
                return False, [f"\U0001F4E6 Order Details - Order #{self.ORDER}\nCustomerID: {self.OWNER}\n"]
            return False, ["Recommended products"]
        return respond

    def run_checks(self, leak=False):
        instance, report = canary()
        owner, foreign = (SimpleNamespace(customer_id=value, token=lambda resource, value=value: str(value))
                          for value in [self.OWNER, self.FOREIGN])
        with patch.object(auth, "consumer_mcp_tool_call", side_effect=self.server(leak)):
            instance.mcp_ownership(self.ORDER, owner, foreign)
        return {check["id"]: check["status"] for check in report.checks}

    def test_two_owner_order_tools_pass_against_enforcing_server(self):
        checks = self.run_checks()
        self.assertEqual(len(checks), 1 + 2 * (4 + 3 * 5))
        self.assertEqual(set(checks.values()), {"PASS"})

    def test_new_ownership_tool_breaks_closure(self):
        self.assertEqual(order_canary.mcp_owner_tools(), sorted(order_canary.MCP_OWNER_TOOLS))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / order_canary.MCP_POLICY_SOURCE
            path.parent.mkdir(parents=True)
            path.write_text((auth.ROOT / order_canary.MCP_POLICY_SOURCE).read_text() +
                            'new("get_owned_carts", OAuthScopes.OrdersRead, ToolAccessMode.SelfOrInternal, "customerId"),')
            self.assertIn("get_owned_carts", order_canary.mcp_owner_tools(Path(directory)))

    def test_cross_owner_leak_fails_every_owner_argument_check(self):
        checks = self.run_checks(leak=True)
        failed = {key for key, value in checks.items() if value == "FAIL"}
        self.assertEqual(failed, {f"order:mcp:{name}:{tool}:other-owner" for name in ["owner", "foreign"]
                                  for tool in order_canary.MCP_OWNER_TOOLS} |
                         {f"order:mcp:{name}:{tool}:{label}" for name in ["owner", "foreign"]
                          for tool in order_canary.MCP_OWNER_TOOLS for label, _ in order_canary.MCP_MALFORMED_OWNERS})


class EmailBoundaryTests(unittest.TestCase):
    service = ("    protected virtual EmailClient CreateEmailClient() =>\n        new(new Uri(x), c);\n"
               "    public async Task<bool> Send(string to)\n    {\n{guard}        var client = CreateEmailClient();\n"
               "    }\n")

    def violations(self, guard, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "api-functions/Services").mkdir(parents=True)
            (root / auth.EMAIL_SERVICE).write_text(self.service.replace("{guard}", guard))
            if extra:
                (root / "api-mcp").mkdir()
                (root / "api-mcp/Mail.cs").write_text("using Azure.Communication.Email;")
            return auth.email_send_boundary_violations(root)

    def test_repository_boundary_is_guarded(self):
        self.assertEqual(auth.email_send_boundary_violations(), [])

    def test_missing_guard_and_second_sdk_site_are_detected(self):
        guarded = "        if (EmailRecipientPolicy.IsReservedNonDeliverable(to)) return false;\n"
        self.assertEqual(self.violations(guarded), [])
        self.assertTrue(self.violations(""))
        self.assertTrue(self.violations(guarded, extra=True))


if __name__ == "__main__":
    unittest.main()
