import hashlib
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import validate

sys.modules.setdefault("validate", validate)
import agent_sweep  # noqa: E402

TRACE_A = "a" * 31 + "1"
TRACE_B = "b" * 31 + "2"
CLIENT = "11111111-2222-3333-4444-555555555555"
PRINCIPAL = "99999999-8888-7777-6666-555555555555"
EXPECTED = hashlib.sha256(CLIENT.encode()).hexdigest()


def table(columns, rows):
    return {"tables": [{"columns": [{"name": name} for name in columns], "rows": rows}]}


class FakeDeployment:
    runtime = None

    def __init__(self, responses=None):
        self.values = {"AZURE_RESOURCE_GROUP": "rg", "USER_MANAGED_IDENTITY_NAME": "id",
                       "API_FUNCTIONS_URL": "https://functions.example.test", "AI_AGENT_ADMIN_CHAT_ID": "admin-chat",
                       "AI_AGENT_CUSTOMER_ID": "customer-gen"}
        self.responses = responses or {}
        self.queries = []

    def required(self, key):
        return self.values[key]

    def azure(self, *args):
        if args[:2] == ("identity", "show"):
            return {"principalId": PRINCIPAL, "clientId": CLIENT}
        if args[:2] == ("resource", "list"):
            return ["/subscriptions/0/app"]
        query = args[args.index("--analytics-query") + 1]
        self.queries.append(query)
        for marker, response in self.responses.items():
            if marker in query:
                return response(query) if callable(response) else response
        raise AssertionError("Unexpected query")


def token(subject="0f8fad5b-d9cb-469f-a165-70867728950e"):
    import base64
    body = base64.urlsafe_b64encode(json.dumps({"sub": subject}).encode()).decode().rstrip("=")
    return "e30." + body + ".sig"


class RegistryTests(unittest.TestCase):
    def test_registry_scopes_cover_every_reviewed_chat_and_generation_tool(self):
        scopes = agent_sweep.tool_scopes()
        self.assertEqual(scopes["get_business_stats"], "sales.read")
        self.assertEqual(scopes["get_customer_orders"], "orders.read")
        self.assertEqual(scopes["generate_random_customer"], "admin.write")
        self.assertLessEqual(validate.ADMIN_CHAT_TOOLS | validate.CUSTOMER_CHAT_TOOLS |
                             agent_sweep.ORDER_GENERATION_TOOLS, set(scopes))

    def test_duplicate_or_unknown_registry_entries_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / agent_sweep.MCP_AUTH_DIRECTORY
            directory.mkdir(parents=True)
            (directory / "OAuthScopes.cs").write_text('public const string A = "a.read";')
            for body in ['new("x", OAuthScopes.A, m), new("x", OAuthScopes.A, m)', 'new("x", OAuthScopes.B, m)']:
                (directory / "ToolAuthorizationPolicy.cs").write_text(body)
                with self.assertRaises(validate.EvidenceError):
                    agent_sweep.tool_scopes(Path(root))

    def test_prompts_close_each_chat_agent_tool_set(self):
        self.assertEqual(set(agent_sweep.admin_prompts()), validate.ADMIN_CHAT_TOOLS)
        self.assertEqual(set(agent_sweep.customer_prompts(7)) | set(agent_sweep.owner_prompts(9)),
                         validate.CUSTOMER_CHAT_TOOLS)
        for invalid in [None, 0, True, "7"]:
            with self.assertRaises(validate.EvidenceError):
                agent_sweep.customer_prompts(invalid)

    def test_pure_generators_do_not_open_sql(self):
        root = validate.ROOT / "api-mcp/AdventureWorks"
        for name in ["Tools/CustomerGeneratorMcpTools.cs", "Services/CustomerGeneratorService.cs"]:
            self.assertNotRegex((root / name).read_text(), r"SqlConnection|SqlCommand|Microsoft\.Data")


class CorrelationTests(unittest.TestCase):
    def test_query_binds_registry_scopes_and_rejects_untrusted_traces(self):
        query = agent_sweep.correlation_query([TRACE_A], "agent", "admin-chat", "x == 'h'", "employee", "app",
                                              {"get_business_stats": "sales.read"})
        self.assertIn("datatable(Tool:string, Scope:string)['get_business_stats', 'sales.read']", query)
        self.assertIn("join kind=inner Expected on Tool, Scope", query)
        for traces in [[], ["0" * 32], ["x' or 1==1 //" + "a" * 20], [TRACE_A, TRACE_A]]:
            with self.assertRaises(validate.EvidenceError):
                agent_sweep.valid_traces(traces)

    def test_correlate_rejects_rows_for_other_agents_or_traces(self):
        columns = ["AgentVersionId", "Tool", "operation_Id", "Hits"]
        for row in [["other:1", "search_products", TRACE_A, 1], ["agent:1", "search_products", TRACE_B, 1],
                    ["agent:1", "unreviewed", TRACE_A, 1]]:
            deployment = FakeDeployment({"Foundry.Responses.Completed": table(columns, [row])})
            with self.assertRaises(validate.EvidenceError):
                agent_sweep.correlate(deployment, "app", [TRACE_A], "agent", "p", "s", "c", "a",
                                      {"search_products": "products.read"}, sleep=lambda _: None)


class SqlPrincipalTests(unittest.TestCase):
    def report(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        return validate.Report(Path(self.directory.name))

    def test_status_requires_every_event_to_prove_the_runtime_identity(self):
        def found(good, servers):
            return {(TRACE_A, "api-mcp", "tool:x"): {"events": 2, "good": good, "servers": servers}}
        self.assertEqual(agent_sweep.sql_status(found(2, [EXPECTED]), {TRACE_A}, "api-mcp", "tool:x", EXPECTED),
                         ("PASS", 2))
        self.assertEqual(agent_sweep.sql_status(found(1, [EXPECTED]), {TRACE_A}, "api-mcp", "tool:x", EXPECTED)[0],
                         "FAIL")
        self.assertEqual(agent_sweep.sql_status(found(2, ["f" * 64]), {TRACE_A}, "api-mcp", "tool:x", EXPECTED)[0],
                         "FAIL")
        self.assertEqual(agent_sweep.sql_status(found(2, [EXPECTED]), {TRACE_B}, "api-mcp", "tool:x", EXPECTED),
                         ("BLOCKED", 0))

    def test_pure_tools_fail_when_sql_is_observed(self):
        report = self.report()
        found = {(TRACE_A, "api-mcp", "tool:generate_random_customer"): {"events": 1, "good": 1,
                                                                         "servers": [EXPECTED]}}
        agent_sweep.report_sql_principal(report, "a", found, {TRACE_A}, "api-mcp", "tool:generate_random_customer",
                                         EXPECTED, "x", pure=True)
        agent_sweep.report_sql_principal(report, "b", {}, {TRACE_A}, "api-mcp", "tool:generate_random_customer",
                                         EXPECTED, "x", pure=True)
        self.assertEqual([check["status"] for check in report.checks], ["FAIL", "PASS"])
        self.assertNotIn(CLIENT, json.dumps(report.inventory))


class SweepTests(unittest.TestCase):
    def test_sweep_retries_skips_done_and_credits_only_correlated_tools(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        report = validate.Report(Path(directory.name))
        report.inventory["adminChatCorrelatedTools"] = [{"version": "admin-chat:3", "tool": "get_business_stats",
                                                         "matches": 1}]
        report.inventory["adminChatTraceId"] = TRACE_B
        sent = []

        def fake_http(method, url, **kwargs):
            sent.append(kwargs["data"]["message"])
            used = ["get_top_customers"] if "get_top_customers" in kwargs["data"]["message"] else []
            return 200, {}, json.dumps({"response": "ok", "toolsUsed": used})

        def correlation(query):
            trace = query.split("operation_Id in ('")[1][:32]
            return table(["AgentVersionId", "Tool", "operation_Id", "Hits"],
                         [["admin-chat:3", "get_top_customers", trace, 1]])

        sql = table(["operation_Id", "Service", "Scope", "Events", "Good", "Servers"],
                    [[TRACE_B, "api-mcp", "tool:get_business_stats", 1, 1, json.dumps([EXPECTED])]])
        deployment = FakeDeployment({"Foundry.Responses.Completed": correlation, "Sql.SessionPrincipal": sql})
        prompts = {tool: agent_sweep.admin_prompts()[tool] for tool in ["get_business_stats", "get_top_customers",
                                                                          "get_top_selling_products"]}
        with mock.patch.object(validate, "http", fake_http):
            agent_sweep.chat_sweep(report, deployment, "admin-chat", token, prompts, validate.ADMIN_CHAT_TOOLS,
                                   agent_key="AI_AGENT_ADMIN_CHAT_ID", category="employee",
                                   client_app="adventureworks-admin", inventory_key="adminChatCorrelatedTools",
                                   sleep=lambda _: None)
        self.assertEqual(len(sent), 1 + agent_sweep.SWEEP_ATTEMPTS)
        self.assertNotIn(prompts["get_business_stats"], sent)
        self.assertEqual({item["tool"] for item in report.inventory["adminChatCorrelatedTools"]},
                         {"get_business_stats", "get_top_customers"})
        checks = {check["id"]: check["status"] for check in report.checks}
        self.assertEqual(checks["agent:admin-chat:tool-sweep"], "BLOCKED")
        self.assertEqual(checks["sql-identity:admin-chat:tool:get_top_customers"], "BLOCKED")
        self.assertEqual(checks["sql-identity:admin-chat:tool:get_business_stats"], "PASS")
        self.assertIn(TRACE_B, deployment.queries[-1])
        self.assertIn(hashlib.sha256(b"0f8fad5b-d9cb-469f-a165-70867728950e").hexdigest(),
                      deployment.queries[0])
        self.assertNotIn("0f8fad5b-d9cb-469f-a165-70867728950e", json.dumps(report.inventory))

    def test_generation_canary_correlates_the_service_subject(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        report = validate.Report(Path(directory.name))

        def correlation(query):
            self.assertIn(f"== 'service:{PRINCIPAL}'", query)
            self.assertIn("'adventureworks-agents'", query)
            trace = query.split("operation_Id in ('")[1][:32]
            return table(["AgentVersionId", "Tool", "operation_Id", "Hits"],
                         [["customer-gen:2", "generate_random_customer_for_locale", trace, 1]])

        sql = table(["operation_Id", "Service", "Scope", "Events", "Good", "Servers"], [])
        deployment = FakeDeployment({"Foundry.Responses.Completed": correlation, "Sql.SessionPrincipal": sql})

        def fake_http(method, url, **kwargs):
            self.assertRegex(kwargs["headers"]["traceparent"], r"^00-[a-f0-9]{32}-[a-f0-9]{16}-01$")
            return 200, {}, json.dumps({"success": True, "salesCustomerId": 42, "email": "private@example.invalid"})

        with mock.patch.object(validate, "http", fake_http):
            agent_sweep.customer_generation_canary(report, deployment, "admin-token", sleep=lambda _: None)
        checks = {check["id"]: check["status"] for check in report.checks}
        self.assertEqual(checks["agent:admin-customer:generate"], "PASS")
        self.assertEqual(checks["agent:admin-customer:correlated-tools"], "PASS")
        self.assertEqual(checks["sql-identity:admin-customer:tool:generate_random_customer_for_locale"], "PASS")
        self.assertEqual(report.inventory["generationAgentResiduals"],
                         [{"kind": "ai-generated-customer", "state": "retained", "id": 42}])
        self.assertNotIn("private@", json.dumps(report.inventory))


SEED_CLIENT = "22222222-3333-4444-5555-666666666666"
SEED_HASH = hashlib.sha256(SEED_CLIENT.encode()).hexdigest()


class TelemetryDeployment(FakeDeployment):
    def __init__(self, responses=None):
        super().__init__(responses)
        self.values.update({"SERVICE_API_FUNCTIONS_NAME": "func-app", "SEED_MANAGED_IDENTITY_NAME": "seed-id"})

    def azure(self, *args):
        if args[:2] == ("identity", "show") and "seed-id" in args:
            return {"principalId": PRINCIPAL, "clientId": SEED_CLIENT}
        return super().azure(*args)


class TelemetryCoverageTests(unittest.TestCase):
    since = "2025-01-01T00:00:00Z"

    def statuses(self, report):
        return {check["id"]: check["status"] for check in report.checks}

    def test_producers_pass_only_when_seen_during_the_run(self):
        rows = [["api-mcp", 3], ["func-app", 9], ["app-admin", 1]]
        deployment = TelemetryDeployment({"union requests": table(("Role", "Items"), rows)})
        report = validate.Report(Path(tempfile.mkdtemp()))
        sleeps = []
        agent_sweep.report_telemetry_producers(report, deployment, self.since, sleep=sleeps.append)
        statuses = self.statuses(report)
        self.assertEqual(statuses["telemetry:producer:functions"], "PASS")
        self.assertEqual(statuses["telemetry:producer:api-mcp"], "PASS")
        self.assertEqual(statuses["telemetry:producer:mcp-inspector"], "BLOCKED")
        self.assertEqual(len(sleeps), len(agent_sweep.TELEMETRY_DELAYS) - 1)
        self.assertIn("datetime(2025-01-01T00:00:00Z)", deployment.queries[0])
        self.assertEqual(report.inventory["telemetryProducers"]["functions"], 9)

    def test_producer_inputs_and_rows_fail_closed(self):
        deployment = TelemetryDeployment({"union requests": table(("Role", "Items"), [["intruder", 1]])})
        report = validate.Report(Path(tempfile.mkdtemp()))
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.report_telemetry_producers(report, deployment, self.since, sleep=lambda _: None)
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.producer_query(("api-mcp",), "2025-01-01') | take 1 //")
        deployment.values["SERVICE_API_FUNCTIONS_NAME"] = "x' or 1==1"
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.producer_roles(deployment)

    def exercise(self, sites, inspector_status=200):
        deployment = TelemetryDeployment()
        deployment.values.update({key: f"https://{key.lower()}.example.invalid"
                                  for key in [*agent_sweep.BROWSER_PRODUCERS.values(), "MCP_INSPECTOR_URL"]})
        report = validate.Report(Path(tempfile.mkdtemp()))

        def run(args, *, environment, timeout):
            self.assertEqual(environment["APP_ADMIN_URL"], "https://app_admin_url.example.invalid")
            Path(args[-1]).write_text(json.dumps({"schemaVersion": 1, "sites": sites}))

        with mock.patch.object(validate, "command", side_effect=run), \
                mock.patch.object(validate, "http", return_value=(inspector_status, {}, b"")) as http:
            agent_sweep.exercise_telemetry_producers(report, deployment)
        self.assertEqual(http.call_args.args[1], "https://mcp_inspector_url.example.invalid/health")
        self.assertRegex(http.call_args.kwargs["headers"]["traceparent"], r"^00-[a-f0-9]{32}-[a-f0-9]{16}-01$")
        return self.statuses(report)

    def test_frontend_probe_requires_accepted_telemetry_under_each_own_role(self):
        site = lambda role, accepted=1, matches=True: {"role": role, "accepted": accepted, "roleMatches": matches}
        statuses = self.exercise([site("app-eshop"), site("app-admin", matches=False),
                                  site("app-manufacturing", accepted=0)], inspector_status=503)
        self.assertEqual(statuses["telemetry:browser:app-eshop"], "PASS")
        self.assertEqual(statuses["telemetry:browser:app-admin"], "FAIL")
        self.assertEqual(statuses["telemetry:browser:app-manufacturing"], "FAIL")
        self.assertEqual(statuses["telemetry:exercise:mcp-inspector"], "FAIL")
        with self.assertRaisesRegex(validate.EvidenceError, "every site"):
            self.exercise([site("app-eshop")])

    def seed(self, principals, matched, servers, succeeded, failed):
        columns = ("Principals", "Matched", "Servers", "Succeeded", "Failed")
        deployment = TelemetryDeployment({"Seed.Completed": table(columns, [[principals, matched, servers,
                                                                             succeeded, failed]])})
        report = validate.Report(Path(tempfile.mkdtemp()))
        agent_sweep.report_seed_telemetry(report, deployment)
        return self.statuses(report)

    def test_seed_session_must_be_the_dedicated_seed_identity(self):
        passed = self.seed(2, 2, json.dumps([SEED_HASH]), 1, 0)
        self.assertEqual(passed, {"sql-identity:seed-job:session": "PASS", "telemetry:producer:seed-job": "PASS"})
        runtime = self.seed(1, 1, [EXPECTED], 1, 0)
        self.assertEqual(runtime["sql-identity:seed-job:session"], "FAIL")
        mismatch = self.seed(2, 1, [SEED_HASH], 0, 1)
        self.assertEqual(mismatch, {"sql-identity:seed-job:session": "FAIL", "telemetry:producer:seed-job": "FAIL"})
        absent = self.seed(0, 0, [], 0, 0)
        self.assertEqual(absent, {"sql-identity:seed-job:session": "BLOCKED",
                                  "telemetry:producer:seed-job": "BLOCKED"})


PROJECT = "https://foundry.example.test/api/projects/p"
HOSTED_COLUMNS = ("AgentRequests", "TokenExchanges", "McpTokens", "McpCalls", "ToolDecisions")


def hosted_body(text, extra_items=()):
    return json.dumps({"object": "response", "status": "completed", "error": None, "output": [
        *extra_items, {"type": "message", "status": "completed",
                       "content": [{"type": "output_text", "text": text}]}]}).encode()


class HostedAgentTests(unittest.TestCase):
    def run_canary(self, raw, rows, status=200):
        deployment = FakeDeployment({"POST /responses": table(HOSTED_COLUMNS, rows)})
        deployment.values.update({"AI_FOUNDRY_PROJECT_ENDPOINT": PROJECT,
                                  "MANUFACTURING_AGENT_ENDPOINT": PROJECT + agent_sweep.HOSTED_AGENT_PATH,
                                  "MCP_SERVICE_URL": "https://mcp.example.test/mcp"})
        report = validate.Report(Path(tempfile.mkdtemp()))
        with mock.patch.object(validate, "command", return_value="token\n"), \
                mock.patch.object(validate, "http", return_value=(status, {}, raw)) as http:
            agent_sweep.hosted_manufacturing_canary(report, deployment, sleep=lambda _: None)
        self.assertEqual(http.call_args.args[1], PROJECT + agent_sweep.HOSTED_AGENT_PATH)
        self.assertNotIn("SalesOrderID=", http.call_args.kwargs["data"]["input"])
        trace = report.inventory["hostedAgentTrace"]
        self.assertIn(f"operation_Id in ('{trace}')", deployment.queries[0])
        self.assertIn("target == 'mcp.example.test'", deployment.queries[0])
        return {check["id"]: check["status"] for check in report.checks}

    def test_no_tool_probe_passes_only_with_the_full_correlated_token_path(self):
        empty = '{"findingsSummary":"x","toolsUsed":[],"recommendedActions":[],"actionsExecuted":[]}'
        passed = self.run_canary(hosted_body(empty), [[1, 1, 1, 2, 0]])
        self.assertEqual(passed, {"agent:manufacturing-agent:hosted-invoke": "PASS",
                                  "telemetry:hosted-manufacturing-agent:trace": "PASS"})
        tool_call = self.run_canary(hosted_body(empty, [{"type": "mcp_call", "name": "get_order_details"}]),
                                    [[1, 1, 1, 2, 1]])
        self.assertEqual(tool_call, {"agent:manufacturing-agent:hosted-invoke": "FAIL",
                                     "telemetry:hosted-manufacturing-agent:trace": "FAIL"})
        acted = self.run_canary(hosted_body(empty.replace('"actionsExecuted":[]', '"actionsExecuted":["WO #1"]')),
                                [[1, 0, 0, 0, 0]])
        self.assertEqual(acted, {"agent:manufacturing-agent:hosted-invoke": "FAIL",
                                 "telemetry:hosted-manufacturing-agent:trace": "FAIL"})
        refused = self.run_canary(hosted_body('{"error":{"code":"missing_sales_order_id"}}'), [[1, 1, 1, 0, 0]])
        self.assertEqual(refused["agent:manufacturing-agent:hosted-invoke"], "PASS")
        prose = self.run_canary(hosted_body("No order supplied."), [[1, 1, 1, 0, 0]])
        self.assertEqual(prose["agent:manufacturing-agent:hosted-invoke"], "FAIL")
        cached_listing = self.run_canary(hosted_body(empty), [[1, 1, 1, 0, 0]])
        self.assertEqual(cached_listing["telemetry:hosted-manufacturing-agent:trace"], "PASS")
        no_exchange = self.run_canary(hosted_body(empty), [[1, 1, 0, 0, 0]])
        self.assertEqual(no_exchange["telemetry:hosted-manufacturing-agent:trace"], "FAIL")
        missing = self.run_canary(b"{}", [[0, 0, 0, 0, 0]], status=403)
        self.assertEqual(missing, {"agent:manufacturing-agent:hosted-invoke": "FAIL",
                                   "telemetry:hosted-manufacturing-agent:trace": "BLOCKED"})

    def test_endpoint_and_host_inputs_fail_closed(self):
        deployment = FakeDeployment()
        deployment.values.update({"AI_FOUNDRY_PROJECT_ENDPOINT": PROJECT,
                                  "MANUFACTURING_AGENT_ENDPOINT": "https://other.example.test/api/projects/p" +
                                                                  agent_sweep.HOSTED_AGENT_PATH})
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.hosted_agent_endpoint(deployment)
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.hosted_query(TRACE_A, "x' or 1==1")


class SeedModuleProbeTests(unittest.TestCase):
    def test_probe_uses_the_real_module_without_exposing_the_connection_string(self):
        deployment = FakeDeployment({"Seed.TelemetryProbe": table(("Items",), [[1]])})
        deployment.values["APPLICATIONINSIGHTS_CONNECTION_STRING"] = "InstrumentationKey=secret"
        report = validate.Report(Path(tempfile.mkdtemp()))
        with mock.patch.object(validate, "command") as command:
            agent_sweep.seed_module_probe(report, deployment, sleep=lambda _: None)
        args, kwargs = command.call_args.args[0], command.call_args.kwargs
        self.assertEqual(args[0], "pwsh")
        self.assertIn("./seed-job/SeedTelemetry.psm1", args[-1])
        self.assertNotIn("secret", " ".join(args))
        self.assertEqual(kwargs["environment"]["SEED_PROBE_CONNECTION"], "InstrumentationKey=secret")
        self.assertIn(kwargs["environment"]["SEED_PROBE_NONCE"], deployment.queries[0])
        self.assertEqual(report.checks[0]["status"], "PASS")
        with self.assertRaises(validate.EvidenceError):
            agent_sweep.seed_probe_query("x' or 1==1")


class CliTests(unittest.TestCase):
    def test_new_flags_require_a_reviewed_canary(self):
        for argv in [["--live", "--agent-tool-sweep"], ["--chat", "--generation-agent-canary"],
                     ["--order-canary", "--generation-agent-canary"], ["--chat", "--hosted-agent-canary"]]:
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                validate.main(argv)

    def test_generation_reconciliation_requires_current_run_evidence(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        report = validate.Report(Path(directory.name))
        report.add("agent:admin-order:generate", "agents", "FAIL", "x")
        report.add("agent:admin-order:correlated-tools", "agents", "PASS", "x")
        with self.assertRaises(validate.EvidenceError):
            validate.reconcile_generation_tool_paths(report, FakeDeployment(), "admin-order")


if __name__ == "__main__":
    unittest.main()
