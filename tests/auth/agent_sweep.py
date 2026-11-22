"""Opt-in agent tool sweep, generation-agent canaries and downstream SQL principal evidence.

Group 1: targeted delegated chat prompts for each reviewed read-only tool that a run has not yet
correlated. Group 2: the service-token customer and order generation agents through their normal
admin entry points. Group 6: every correlated trace is matched to `Sql.SessionPrincipal` events that
the MCP and Functions workloads emit when they open SQL connections, proving the SQL server saw the
selected runtime managed identity. Only hashes, tool names and categorical outcomes are exported.

Application Insights ingestion accepts the shared connection string (a documented exception), so
every probe uses fresh random W3C trace IDs that a forger could not predict before the run.
"""

import base64
import binascii
import hashlib
import json
import re
import time
import uuid

import validate as auth

MCP_AUTH_DIRECTORY = "api-mcp/AdventureWorks/Auth"
SQL_EVENT = "Sql.SessionPrincipal"
SQL_MAX_VERIFIED_AGE_SECONDS = 1200
SWEEP_ATTEMPTS = 2
TELEMETRY_DELAYS = (0, 30, 30, 30, 30)
# Bogus-only generators; their source must not open SQL (asserted by unit tests).
PURE_TOOLS = frozenset({"generate_random_customer", "generate_random_customer_for_locale"})
SERVICE_APP = "adventureworks-agents"
CUSTOMER_GENERATION_TOOLS = frozenset(PURE_TOOLS)
ORDER_GENERATION_TOOLS = frozenset({
    "search_products", "get_product_details", "get_categories_with_products", "get_active_promotions",
    "find_complementary_products", "check_inventory_availability", "search_customers",
    "get_customer_orders", "get_order_details", "get_personalized_recommendations",
    "generate_random_customer", "generate_random_customer_for_locale",
})
BASE_TRACE_KEYS = {"admin-chat": "adminChatTraceId", "customer-chat": "customerChatTraceId"}
OWNER_CHAT_TOOLS = ("get_customer_orders", "get_order_details", "get_personalized_recommendations")


def tool_scopes(root=None):
    """Tool → required scope from the MCP authorization registry, the runtime source of truth."""
    directory = (root or auth.ROOT) / MCP_AUTH_DIRECTORY
    constants = dict(re.findall(r'public const string (\w+) = "([^"]+)";',
                                (directory / "OAuthScopes.cs").read_text()))
    policies = {}
    for tool, scope in re.findall(r'new\("([a-z_]+)",\s*OAuthScopes\.(\w+)\s*,',
                                  (directory / "ToolAuthorizationPolicy.cs").read_text()):
        if tool in policies or scope not in constants:
            raise auth.EvidenceError("The MCP tool scope registry could not be parsed unambiguously")
        policies[tool] = constants[scope]
    if not policies:
        raise auth.EvidenceError("The MCP tool scope registry is empty")
    return policies


def admin_prompts():
    search = "Search the catalog for 'helmet'"
    return {
        "get_business_stats": "Show the business dashboard. Use get_business_stats.",
        "get_sales_report_by_status": "Summarize sales grouped by order status. Use get_sales_report_by_status.",
        "get_top_selling_products": "List the three top-selling products. Use get_top_selling_products.",
        "get_top_customers": "Who are our five top customers by spend? Use get_top_customers.",
        "get_orders_by_status": "List up to five orders in status 5 (shipped). Use get_orders_by_status.",
        "get_product_performance_summary": search + " with search_products, then show the sales performance "
                                                    "summary for the first result with get_product_performance_summary.",
        "get_recent_customers_without_orders":
            "Which recently registered customers have not ordered yet? Use get_recent_customers_without_orders.",
        "search_customers": "Search customers with the name 'Smith'. Use search_customers.",
        "search_products": search + ". Use search_products.",
        "get_product_details": search + " with search_products, then show the first result's full details "
                                        "with get_product_details.",
        "check_inventory_availability": search + " with search_products, then check warehouse inventory for "
                                                 "the first result with check_inventory_availability.",
        "get_categories_with_products": "List the product categories with example products. "
                                        "Use get_categories_with_products.",
        "get_products_for_promotion": "Which products are good promotion candidates? Use get_products_for_promotion.",
        "get_active_promotions": "List the active promotions. Use get_active_promotions.",
        "analyze_product_reviews": search + " with search_products, then summarize customer reviews for the "
                                            "first result with analyze_product_reviews.",
    }


def customer_prompts(product_id):
    if type(product_id) is not int or product_id <= 0:
        raise auth.EvidenceError("A confirmed catalog product is required for the customer sweep")
    return {
        "search_products": "Search the store for helmets. Use search_products.",
        "get_product_details": f"Show me the full details of product ID {product_id}. Use get_product_details.",
        "find_complementary_products": f"What goes well with product ID {product_id}? "
                                       "Use find_complementary_products.",
        "analyze_product_reviews": f"What do customers say about product ID {product_id}? "
                                   "Use analyze_product_reviews.",
        "get_product_availability": f"Is product ID {product_id} in stock? Use get_product_availability.",
    }


def owner_prompts(order_id):
    if type(order_id) is not int or order_id <= 0:
        raise auth.EvidenceError("An owned order is required for the customer owner-tool sweep")
    return {
        "get_customer_orders": "Show my recent orders. Use get_customer_orders.",
        "get_order_details": f"Show the details of my order {order_id}. Use get_order_details.",
        "get_personalized_recommendations": "Recommend products for me based on my order history. "
                                            "Use get_personalized_recommendations.",
    }


def new_trace():
    return uuid.uuid4().hex


def traceparent(trace):
    return f"00-{trace}-{uuid.uuid4().hex[:16]}-01"


def token_subject_hash(token):
    try:
        payload = token.split(".")[1]
        subject = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"]
        if not isinstance(subject, str) or str(uuid.UUID(subject)) != subject:
            raise ValueError("Invalid subject")
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, binascii.Error) as error:
        raise auth.EvidenceError("The delegated token has invalid subject metadata") from error
    return hashlib.sha256(subject.encode()).hexdigest()


def runtime_identity(deployment):
    """Principal (MCP service subject) and client ID hash (SQL login) of the selected runtime UAMI."""
    identity = deployment.azure("identity", "show", "-g", deployment.required("AZURE_RESOURCE_GROUP"),
                                "-n", deployment.required("USER_MANAGED_IDENTITY_NAME"))
    try:
        principal = str(uuid.UUID(identity["principalId"]))
        client = str(uuid.UUID(identity["clientId"]))
    except (ValueError, KeyError, TypeError) as error:
        raise auth.EvidenceError("The selected runtime managed identity is unavailable") from error
    return principal, hashlib.sha256(client.encode()).hexdigest()


def telemetry_app(deployment):
    resources = deployment.azure("resource", "list", "--resource-group",
                                 deployment.required("AZURE_RESOURCE_GROUP"),
                                 "--resource-type", "Microsoft.Insights/components", "--query", "[].id")
    if (not isinstance(resources, list) or len(resources) != 1 or
            not isinstance(resources[0], str) or not resources[0]):
        raise auth.EvidenceError("A unique selected-environment telemetry resource is required")
    return resources[0]


def query_rows(deployment, app, query, columns):
    result = deployment.azure("monitor", "app-insights", "query", "--app", app, "--analytics-query", query)
    try:
        table, = result["tables"]
        names = [column["name"] for column in table["columns"]]
        rows = table["rows"]
        if names != list(columns) or not isinstance(rows, list) or \
                any(not isinstance(row, list) or len(row) != len(columns) for row in rows):
            raise ValueError("Unexpected telemetry columns")
    except (KeyError, TypeError, ValueError) as error:
        raise auth.EvidenceError("Telemetry query returned an unsupported shape") from error
    return rows


def valid_traces(traces):
    if (not isinstance(traces, (list, tuple, set)) or not traces or
            any(not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{32}", value) is None or value == "0" * 32
                for value in traces) or len(set(traces)) != len(traces)):
        raise auth.EvidenceError("Run-specific traces are missing or invalid")
    return ", ".join("'" + value + "'" for value in sorted(traces))


def correlation_query(traces, agent_id, policy, subject_clause, category, app, scopes):
    expected = ", ".join(f"'{tool}', '{scope}'" for tool, scope in sorted(scopes.items()))
    trace_list = valid_traces(traces)
    return (
        f"let Expected = datatable(Tool:string, Scope:string)[{expected}]; "
        "let Completed = customEvents | where timestamp > ago(2h) "
        f"| where operation_Id in ({trace_list}) and name == 'Foundry.Responses.Completed' "
        f"| where tostring(customDimensions.AgentId) == '{agent_id}' "
        f"| where tostring(customDimensions.ToolPolicy) == '{policy}' "
        "| extend AgentVersionId=tostring(customDimensions.AgentVersionId), "
        "Tool=split(tostring(customDimensions.CompletedMcpTools), ',') "
        "| mv-expand Tool to typeof(string) | project operation_Id, AgentVersionId, Tool; "
        "let Authorized = customEvents | where timestamp > ago(2h) "
        f"| where operation_Id in ({trace_list}) and name == 'McpToolAuthorization' "
        f"| where {subject_clause} "
        f"| where tostring(customDimensions.category) == '{category}' "
        f"and tostring(customDimensions.app) == '{app}' "
        "and tostring(customDimensions.outcome) == 'Allow' "
        "and tostring(customDimensions.allowed) == 'true' "
        "| project operation_Id, Tool=tostring(customDimensions.tool), "
        "Scope=tostring(customDimensions.requiredScope) "
        "| join kind=inner Expected on Tool, Scope | project operation_Id, Tool; "
        "Completed | join kind=inner Authorized on operation_Id, Tool "
        "| summarize Hits=count() by AgentVersionId, Tool, operation_Id "
        "| order by AgentVersionId asc, Tool asc, operation_Id asc"
    )


def correlate(deployment, app, traces, agent_id, policy, subject_clause, category, client_app, scopes,
              *, sleep=time.sleep):
    """Returns {(version, tool): {"matches": n, "traces": set}} for authorized completed tool calls."""
    if re.fullmatch(r"[A-Za-z0-9_-]+", agent_id) is None:
        raise auth.EvidenceError("The selected agent ID is not a supported telemetry identity")
    query = correlation_query(traces, agent_id, policy, subject_clause, category, client_app, scopes)
    observed = {}
    for delay in TELEMETRY_DELAYS:
        if delay:
            sleep(delay)
        for version, tool, trace, hits in query_rows(deployment, app, query,
                                                     ["AgentVersionId", "Tool", "operation_Id", "Hits"]):
            if (not isinstance(version, str) or re.fullmatch(re.escape(agent_id) + r":[1-9][0-9]*", version) is None
                    or tool not in scopes or trace not in traces or type(hits) is not int or hits <= 0):
                raise auth.EvidenceError("Agent correlation telemetry returned an unexpected row")
            entry = observed.setdefault((version, tool), {"matches": 0, "traces": set()})
            entry["matches"] = max(entry["matches"], hits)
            entry["traces"].add(trace)
        if {tool for _, tool in observed} >= set(scopes):
            break
    return observed


def sql_query(traces):
    return (
        "customEvents | where timestamp > ago(2h) "
        f"| where operation_Id in ({valid_traces(traces)}) and name == '{SQL_EVENT}' "
        "| extend Service=tostring(customDimensions.Service), Scope=tostring(customDimensions.Scope), "
        "Match=tostring(customDimensions.PrincipalMatch), Server=tostring(customDimensions.ServerPrincipalHash), "
        "Expected=tostring(customDimensions.ExpectedClientHash), "
        "Probe=tostring(customDimensions.ConnectionMatchesProbe), "
        "Age=tolong(customDimensions.VerifiedAgeSeconds) "
        "| summarize Events=count(), Good=countif(Match == 'match' and Server == Expected and Probe == 'true' "
        f"and Age >= 0 and Age <= {SQL_MAX_VERIFIED_AGE_SECONDS}), "
        "Servers=make_set(Server, 4) by operation_Id, Service, Scope "
        "| order by operation_Id asc, Service asc, Scope asc"
    )


def sql_principals(deployment, app, traces, *, sleep=time.sleep, required=()):
    """Returns {(trace, service, scope): {"events", "good", "servers"}} for the given traces."""
    query = sql_query(traces)
    found = {}
    for delay in TELEMETRY_DELAYS:
        if delay:
            sleep(delay)
        for trace, service, scope, events, good, servers in query_rows(
                deployment, app, query, ["operation_Id", "Service", "Scope", "Events", "Good", "Servers"]):
            if isinstance(servers, str):
                try:
                    servers = json.loads(servers)
                except ValueError as error:
                    raise auth.EvidenceError("SQL principal telemetry returned an unexpected row") from error
            if (trace not in traces or service not in {"api-mcp", "api-functions"} or not isinstance(scope, str) or
                    type(events) is not int or type(good) is not int or not 0 <= good <= events or
                    not isinstance(servers, list) or not all(isinstance(item, str) for item in servers)):
                raise auth.EvidenceError("SQL principal telemetry returned an unexpected row")
            found[(trace, service, scope)] = {"events": events, "good": good, "servers": sorted(servers)}
        if all(any(key[1:] == item for key in found) for item in required):
            break
    return found


def sql_status(found, traces, service, scope, expected_hash):
    """PASS only when every event for the scope proves the expected runtime principal."""
    rows = [value for (trace, svc, sc), value in found.items() if trace in traces and svc == service and sc == scope]
    if not rows:
        return "BLOCKED", 0
    events = sum(row["events"] for row in rows)
    good = all(row["good"] == row["events"] and row["servers"] == [expected_hash] for row in rows)
    return ("PASS" if good else "FAIL"), events


def report_sql_principal(report, check_id, found, traces, service, scope, expected_hash, label, *, pure=False):
    status, events = sql_status(found, traces, service, scope, expected_hash)
    if pure:
        status = "PASS" if events == 0 else "FAIL"
        detail = (f"{label} is a pure generator: no SQL connection was opened on its traces."
                  if status == "PASS" else f"{label} unexpectedly opened SQL connections.")
    else:
        detail = {
            "PASS": f"{label}: all {events} SQL connection event(s) on the run's traces were served to the selected "
                    "runtime managed identity (SQL-reported login), on the configured server and database.",
            "FAIL": f"{label}: SQL reported a principal or target other than the selected runtime identity.",
            "BLOCKED": f"{label}: no SQL connection event was observed on the run's traces.",
        }[status]
    report.add(check_id, "sql-identity", status, detail)
    inventory = report.inventory.setdefault("sqlSessionPrincipals", [])
    inventory.append({"check": check_id, "service": service, "scope": scope, "events": events, "status": status})
    return status


def merge_observations(report, key, observed):
    existing = {(item["version"], item["tool"]): item["matches"]
                for item in report.inventory.get(key, []) if isinstance(item, dict)}
    for pair, value in observed.items():
        existing[pair] = max(existing.get(pair, 0), value["matches"])
    report.inventory[key] = [{"version": version, "tool": tool, "matches": existing[(version, tool)]}
                             for version, tool in sorted(existing)]


def chat(deployment, token, message, is_admin, allowed_tools):
    trace = new_trace()
    status, _, raw = auth.http(
        "POST", auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/agent/chat",
        token=token, timeout=300, data={"message": message, "isAdmin": is_admin, "cultureId": "en"},
        headers={"traceparent": traceparent(trace)})
    try:
        response = json.loads(raw)
    except (ValueError, TypeError):
        response = None
    text = response.get("response", response.get("Response")) if isinstance(response, dict) else None
    tools = response.get("toolsUsed", response.get("ToolsUsed")) if isinstance(response, dict) else None
    valid = (status == 200 and isinstance(text, str) and bool(text.strip()) and isinstance(tools, list) and
             all(isinstance(name, str) for name in tools) and set(tools) <= allowed_tools)
    return trace, valid, (set(tools) if valid else set())


def chat_sweep(report, deployment, profile, token_provider, prompts, allowed_tools, *, agent_key,
               category, client_app, inventory_key, label=None, sleep=time.sleep):
    """Prompts each uncorrelated tool, then correlates authorization, completion and SQL identity."""
    if getattr(deployment, "runtime", None):
        raise auth.EvidenceError("The agent tool sweep requires the local deployer and telemetry access")
    label = label or profile
    scopes = tool_scopes()
    if not set(prompts) <= allowed_tools or not set(prompts) <= set(scopes):
        raise auth.EvidenceError("Sweep prompts must target reviewed, registered tools")
    done = {item["tool"] for item in report.inventory.get(inventory_key, []) if isinstance(item, dict)}
    targets = sorted(set(prompts) - done)
    agent_id = deployment.required(agent_key)
    token = token_provider()
    subject_hash = token_subject_hash(token)
    traces = []
    reported = set()
    for tool in targets:
        for _ in range(SWEEP_ATTEMPTS):
            trace, valid, used = chat(deployment, token, prompts[tool], category == "employee", allowed_tools)
            traces.append(trace)
            if valid:
                reported |= used
            if tool in used:
                break
    report.inventory.setdefault("agentSweepTraces", {})[label] = len(traces)
    if not traces:
        report.add(f"agent:{label}:tool-sweep", "agents", "PASS",
                   "Every reviewed tool was already correlated in this run; no sweep request was sent.")
        return {}
    app = telemetry_app(deployment)
    observed = correlate(deployment, app, traces, agent_id, profile,
                         f"hash_sha256(tostring(customDimensions.subject)) == '{subject_hash}'",
                         category, client_app, {tool: scopes[tool] for tool in prompts}, sleep=sleep)
    merge_observations(report, inventory_key, observed)
    # Tools the base canary already correlated get SQL evidence from that canary's own trace.
    sql_observed, sql_traces = dict(observed), list(traces)
    base = report.inventory.get(BASE_TRACE_KEYS.get(profile, ""))
    if isinstance(base, str) and re.fullmatch(r"[a-f0-9]{32}", base) and base not in traces:
        sql_traces.append(base)
        for item in report.inventory.get(inventory_key, []):
            if item["tool"] in done & set(prompts):
                sql_observed.setdefault((item["version"], item["tool"]), {"matches": item["matches"],
                                                                          "traces": {base}})
    correlated = {tool for _, tool in observed}
    missing = sorted(set(targets) - correlated)
    report.add(f"agent:{label}:tool-sweep", "agents", "PASS" if not missing else "BLOCKED",
               f"{len(traces)} delegated request(s) on fresh traces; each correlated tool joined a completed "
               "Foundry MCP call to an allowed decision for its registry scope and the same delegated subject." +
               (" Not observed: " + ", ".join(missing) if missing else ""))
    report.guarded(f"sql-identity:{label}:evidence", "sql-identity", lambda: report_sql_paths(
        report, deployment, app, label, sql_observed, sql_traces, sleep=sleep))
    return observed


def report_sql_paths(report, deployment, app, profile, observed, traces, *, sleep=time.sleep):
    _, expected_hash = runtime_identity(deployment)
    tools = sorted({tool for _, tool in observed})
    required = [("api-mcp", "tool:" + tool) for tool in tools if tool not in PURE_TOOLS]
    found = sql_principals(deployment, app, set(traces), sleep=sleep, required=required)
    for tool in tools:
        tool_traces = set().union(*(value["traces"] for (_, name), value in observed.items() if name == tool))
        report_sql_principal(report, f"sql-identity:{profile}:tool:{tool}", found, tool_traces, "api-mcp",
                             "tool:" + tool, expected_hash, f"MCP tool {tool} via {profile}",
                             pure=tool in PURE_TOOLS)
    functions = sorted({scope for (_, service, scope) in found if service == "api-functions"})
    for scope in functions:
        report_sql_principal(report, f"sql-identity:{profile}:{scope}", found, set(traces), "api-functions",
                             scope, expected_hash, f"Functions {scope} via {profile}")


GENERATION_INVENTORY = {"admin-customer": "customerGenerationCorrelatedTools",
                        "admin-order": "orderGenerationCorrelatedTools"}


def service_generation_canary(report, deployment, label, agent_key, policy, tools, request, *, sleep=time.sleep):
    """Invokes a service-token generation agent once on a fresh trace and correlates its tool calls."""
    if getattr(deployment, "runtime", None):
        raise auth.EvidenceError("Generation-agent canaries require the local deployer and telemetry access")
    scopes = tool_scopes()
    if not tools <= set(scopes):
        raise auth.EvidenceError("Generation-agent tools must be registered MCP tools")
    trace = new_trace()
    status, body = request(traceparent(trace))
    report.inventory.setdefault("generationAgentTraces", {})[label] = 1
    principal, _ = runtime_identity(deployment)
    app = telemetry_app(deployment)
    observed = correlate(deployment, app, [trace], deployment.required(agent_key), policy,
                         f"tostring(customDimensions.subject) == 'service:{principal}'", "service", SERVICE_APP,
                         {tool: scopes[tool] for tool in tools}, sleep=sleep)
    merge_observations(report, GENERATION_INVENTORY[label], observed)
    report.add(f"agent:{label}:correlated-tools", "agents", "PASS" if observed else "BLOCKED",
               (f"The run trace joins {len(observed)} completed tool call(s) of the loaded {label} version to "
                "allowed decisions for the Functions runtime identity at each tool's registry scope.")
               if observed else f"No authorized completed {label} tool call was correlated on the run trace.")
    report.guarded(f"sql-identity:{label}:evidence", "sql-identity", lambda: report_sql_paths(
        report, deployment, app, label, observed, [trace], sleep=sleep))
    return status, body, observed


def customer_generation_canary(report, deployment, admin_token, *, sleep=time.sleep):
    residuals = report.inventory.setdefault("generationAgentResiduals", [])

    def request(header):
        residual = {"kind": "ai-generated-customer", "state": "creation-requested"}
        residuals.append(residual)
        status, _, raw = auth.http(
            "POST", auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/customers/generate-with-ai",
            token=admin_token, timeout=300, data={"locale": "en"}, headers={"traceparent": header})
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            body = None
        customer = body.get("salesCustomerId") if isinstance(body, dict) else None
        valid = status == 200 and isinstance(body, dict) and body.get("success") is True and \
            type(customer) is int and customer > 0
        residual.update({"id": customer if valid else None, "state": "retained" if valid else "uncertain"})
        report.check("agent:admin-customer:generate", "agents", valid,
                     f"The admin customer generator returned HTTP {status} and one new customer ID; "
                     "generated personal data is withheld.")
        return status, body

    service_generation_canary(report, deployment, "admin-customer", "AI_AGENT_CUSTOMER_ID",
                              "customer-generation", CUSTOMER_GENERATION_TOOLS, request, sleep=sleep)


# First-party producers expected to report during a live run. The Functions role is the app's own name.
TELEMETRY_PRODUCERS = ("app-eshop", "app-admin", "app-manufacturing", "DataApiBuilder", "api-mcp",
                       "mcp-inspector", "manufacturing-agent")
SEED_TELEMETRY_WINDOW = "30d"


def producer_roles(deployment):
    function_role = deployment.required("SERVICE_API_FUNCTIONS_NAME")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,62}", function_role) is None:
        raise auth.EvidenceError("The selected Functions app name is invalid")
    return TELEMETRY_PRODUCERS + (function_role,)


def producer_query(roles, since):
    if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", since) is None:
        raise auth.EvidenceError("The run start time is invalid")
    names = ", ".join("'" + role + "'" for role in sorted(roles))
    return (
        "union requests, dependencies, traces, customEvents, exceptions, pageViews "
        f"| where timestamp >= datetime({since}) and cloud_RoleName in ({names}) "
        "| summarize Items=count() by Role=cloud_RoleName | order by Role asc"
    )


def report_telemetry_producers(report, deployment, since, *, sleep=time.sleep):
    """Each first-party producer must have reported to the selected resource since the run started."""
    roles = producer_roles(deployment)
    app = telemetry_app(deployment)
    query = producer_query(roles, since)
    seen = {}
    for delay in TELEMETRY_DELAYS:
        if delay:
            sleep(delay)
        seen = {}
        for role, items in query_rows(deployment, app, query, ("Role", "Items")):
            if role not in roles or not isinstance(items, int) or items < 1:
                raise auth.EvidenceError("Telemetry producer query returned an unexpected row")
            seen[role] = items
        if len(seen) == len(roles):
            break
    for role in roles:
        label = "functions" if role == roles[-1] else role
        if role in seen:
            report.add(f"telemetry:producer:{label}", "telemetry", "PASS",
                       f"{label} sent {seen[role]} telemetry item(s) to the selected Application Insights "
                       "resource during this run.")
        else:
            report.add(f"telemetry:producer:{label}", "telemetry", "BLOCKED",
                       f"No {label} telemetry arrived during this run; the producer may not have been exercised "
                       "or ingestion is delayed.")
    report.inventory["telemetryProducers"] = {("functions" if role == roles[-1] else role): seen.get(role, 0)
                                              for role in roles}
    return seen


def seed_identity_hash(deployment):
    identity = deployment.azure("identity", "show", "-g", deployment.required("AZURE_RESOURCE_GROUP"),
                                "-n", deployment.required("SEED_MANAGED_IDENTITY_NAME"))
    try:
        client = str(uuid.UUID(identity["clientId"]))
    except (ValueError, KeyError, TypeError) as error:
        raise auth.EvidenceError("The selected seed managed identity is unavailable") from error
    return hashlib.sha256(client.encode()).hexdigest()


def seed_query():
    return (
        f"customEvents | where timestamp > ago({SEED_TELEMETRY_WINDOW}) and cloud_RoleName == 'seed-job' "
        f"and name in ('{SQL_EVENT}', 'Seed.Completed') "
        "| extend Mode=tostring(customDimensions.Mode), Outcome=tostring(customDimensions.Outcome), "
        "Match=tostring(customDimensions.PrincipalMatch), Server=tostring(customDimensions.ServerPrincipalHash), "
        "Expected=tostring(customDimensions.ExpectedClientHash) "
        f"| summarize Principals=countif(name == '{SQL_EVENT}'), "
        f"Matched=countif(name == '{SQL_EVENT}' and Match == 'match' and Server == Expected), "
        f"Servers=make_set_if(Server, name == '{SQL_EVENT}', 4), "
        "Succeeded=countif(name == 'Seed.Completed' and Mode == 'full' and Outcome == 'succeeded'), "
        "Failed=countif(name == 'Seed.Completed' and Outcome != 'succeeded')"
    )


def report_seed_telemetry(report, deployment):
    """The seed job's own SQL session must be its dedicated identity, and its full seed must have succeeded."""
    expected = seed_identity_hash(deployment)
    rows = query_rows(deployment, telemetry_app(deployment), seed_query(),
                      ("Principals", "Matched", "Servers", "Succeeded", "Failed"))
    if len(rows) != 1:
        raise auth.EvidenceError("Seed telemetry query returned an unexpected shape")
    principals, matched, servers, succeeded, failed = rows[0]
    if isinstance(servers, str):
        servers = json.loads(servers)
    if not all(isinstance(value, int) for value in (principals, matched, succeeded, failed)) or \
            not isinstance(servers, list):
        raise auth.EvidenceError("Seed telemetry query returned an unexpected shape")
    if principals == 0:
        status, detail = "BLOCKED", ("No seed-job SQL session-principal event exists; the deployed seed predates "
                                     "seed telemetry or has not run.")
    elif matched == principals and servers == [expected]:
        status, detail = "PASS", (f"All {principals} seed SQL session(s) were served to the dedicated seed managed "
                                  "identity reported by ARM, independent of the runtime identity.")
    else:
        status, detail = "FAIL", "A seed SQL session was served to a principal other than the seed managed identity."
    report.add("sql-identity:seed-job:session", "sql-identity", status, detail)
    if succeeded:
        report.add("telemetry:producer:seed-job", "telemetry", "PASS",
                   f"The seed job reported {succeeded} successful full seed(s).")
    else:
        report.add("telemetry:producer:seed-job", "telemetry", "BLOCKED" if not failed else "FAIL",
                   "No successful full seed was reported." + (" A failed seed outcome was reported." if failed else
                   " The seed image is built only during provisioning, so a seed built before SeedTelemetry.psm1 "
                   "cannot report until the environment is recreated."))


SEED_PROBE_EVENT = "Seed.TelemetryProbe"
# Connection string and nonce arrive through the environment so neither appears in argv.
SEED_PROBE_SCRIPT = (
    "$ErrorActionPreference = 'Stop'; Import-Module ./seed-job/SeedTelemetry.psm1 -Force; "
    "if (-not (Initialize-SeedTelemetry $env:SEED_PROBE_CONNECTION)) { exit 3 }; "
    f"if (-not (Send-SeedTelemetryEvent '{SEED_PROBE_EVENT}' ([ordered]@{{ Probe = $env:SEED_PROBE_NONCE }}))) "
    "{ exit 4 }"
)


def seed_probe_query(nonce):
    if re.fullmatch(r"[a-f0-9]{32}", nonce) is None:
        raise auth.EvidenceError("The seed probe nonce is invalid")
    return (f"customEvents | where timestamp > ago(2h) and cloud_RoleName == 'seed-job' and name == '{SEED_PROBE_EVENT}' "
            f"and tostring(customDimensions.Probe) == '{nonce}' | summarize Items=count()")


def seed_module_probe(report, deployment, *, sleep=time.sleep):
    """Send one probe event through the real seed telemetry module and require it to arrive as seed-job.

    This proves the module's envelope, role and ingestion path against the selected resource. It does not
    replace the deployed seed's own Seed.Completed evidence, which only a provisioned seed can produce.
    """
    nonce = uuid.uuid4().hex
    environment = dict(auth.os.environ)
    environment.update(SEED_PROBE_CONNECTION=deployment.required("APPLICATIONINSIGHTS_CONNECTION_STRING"),
                       SEED_PROBE_NONCE=nonce)
    auth.command(["pwsh", "-NoProfile", "-NonInteractive", "-Command", SEED_PROBE_SCRIPT],
                 environment=environment, timeout=90)
    app = telemetry_app(deployment)
    items = 0
    for delay in TELEMETRY_DELAYS:
        if delay:
            sleep(delay)
        rows = query_rows(deployment, app, seed_probe_query(nonce), ("Items",))
        if len(rows) != 1 or not isinstance(rows[0][0], int):
            raise auth.EvidenceError("Seed probe query returned an unexpected shape")
        items = rows[0][0]
        if items:
            break
    report.add("telemetry:seed-job:module-ingestion", "telemetry", "PASS" if items == 1 else
               ("BLOCKED" if not items else "FAIL"),
               "One probe event sent by seed-job/SeedTelemetry.psm1 arrived under the seed-job role in the selected "
               "Application Insights resource." if items == 1 else
               (f"The seed module probe arrived {items} times." if items else
                "The seed module probe did not arrive before the query window closed."))


HOSTED_AGENT_ROLE = "manufacturing-agent"
HOSTED_AGENT_PATH = "/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1"
HOSTED_EMPTY_FIELDS = ("toolsUsed", "recommendedActions", "actionsExecuted")
HOSTED_TOOL_ITEMS = frozenset({"mcp_call", "mcp_approval_request", "function_call", "mcp_list_tools"})


def hosted_agent_endpoint(deployment):
    endpoint = deployment.required("MANUFACTURING_AGENT_ENDPOINT")
    if endpoint != auth.https_url(deployment.required("AI_FOUNDRY_PROJECT_ENDPOINT")) + HOSTED_AGENT_PATH:
        raise auth.EvidenceError("The hosted agent endpoint does not belong to the selected Foundry project")
    return endpoint


def hosted_probe_message(run):
    # Not a sales order: ReadOnly mode with no tool calls, so the probe cannot read or change business data.
    return ("Telemetry connectivity probe; not a sales order, so SalesOrderID and CustomerID are intentionally "
            f"absent.\nMode=ReadOnly (1)\nRunID=auth-probe-{run}\nDo not call any tools. Return exactly "
            '{"findingsSummary":"probe","toolsUsed":[],"recommendedActions":[],"actionsExecuted":[]}')


def hosted_probe_result(body):
    """(final agent JSON or None, tool item count) from a completed Responses envelope."""
    if not isinstance(body, dict) or body.get("status") != "completed" or body.get("error") or \
            not isinstance(body.get("output"), list):
        return None, 0
    items = [item for item in body["output"] if isinstance(item, dict)]
    tools = sum(1 for item in items if item.get("type") in HOSTED_TOOL_ITEMS)
    texts = [part.get("text") for item in items if item.get("type") == "message"
             for part in (item.get("content") if isinstance(item.get("content"), list) else [])
             if isinstance(part, dict) and part.get("type") == "output_text"]
    if len(texts) != 1 or not isinstance(texts[0], str):
        return None, tools
    try:
        result = json.loads(texts[0])
    except ValueError:
        return None, tools
    return (result if isinstance(result, dict) else None), tools


def hosted_query(trace, mcp_host):
    if re.fullmatch(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?", mcp_host) is None:
        raise auth.EvidenceError("The selected MCP host is invalid")
    trace_list = valid_traces([trace])
    return (
        "union requests, dependencies, customEvents "
        f"| where timestamp > ago(2h) and operation_Id in ({trace_list}) "
        f"| summarize AgentRequests=countif(itemType == 'request' and cloud_RoleName == '{HOSTED_AGENT_ROLE}' "
        "and name == 'POST /responses' and resultCode == '200'), "
        f"TokenExchanges=countif(itemType == 'dependency' and cloud_RoleName == '{HOSTED_AGENT_ROLE}' "
        f"and name == 'POST /token' and target == '{mcp_host}' and resultCode == '200'), "
        "McpTokens=countif(itemType == 'request' and cloud_RoleName == 'api-mcp' and name == 'POST /token' "
        "and resultCode == '200'), "
        "McpCalls=countif(itemType == 'request' and cloud_RoleName == 'api-mcp' and name == 'POST /mcp' "
        "and resultCode == '200'), "
        "ToolDecisions=countif(itemType == 'customEvent' and name == 'McpToolAuthorization')"
    )


def hosted_manufacturing_canary(report, deployment, *, sleep=time.sleep):
    """One direct no-tool ReadOnly call to the hosted agent, correlated across Foundry, the agent and api-mcp."""
    endpoint = hosted_agent_endpoint(deployment)
    mcp_host = auth.urllib.parse.urlsplit(auth.https_url(deployment.required("MCP_SERVICE_URL"))).hostname
    token = auth.command(["az", "account", "get-access-token", "--resource", "https://ai.azure.com/",
                          "--query", "accessToken", "-o", "tsv"]).strip()
    trace = new_trace()
    report.inventory["hostedAgentTrace"] = trace
    status, _, raw = auth.http("POST", endpoint, token=token, timeout=300,
                               data={"input": hosted_probe_message(trace[:12]), "stream": False},
                               headers={"traceparent": traceparent(trace)})
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        body = None
    result, tools = hosted_probe_result(body)
    report.check("agent:manufacturing-agent:hosted-invoke", "agents",
                 status == 200 and result is not None and tools == 0 and
                 all(result.get(field, []) == [] for field in HOSTED_EMPTY_FIELDS),
                 f"A direct Foundry-authenticated ReadOnly probe returned HTTP {status}, a completed JSON response "
                 "(findings or the agent's error object) with no tool calls, recommendations or actions.")
    columns = ("AgentRequests", "TokenExchanges", "McpTokens", "McpCalls", "ToolDecisions")
    # Foundry may reuse a cached MCP tool listing, so /mcp is informational for a no-tool probe.
    required = columns[:3]
    app = telemetry_app(deployment)
    counts = dict.fromkeys(columns, 0)
    for delay in TELEMETRY_DELAYS:
        if delay:
            sleep(delay)
        rows = query_rows(deployment, app, hosted_query(trace, mcp_host), columns)
        if len(rows) != 1 or not all(isinstance(value, int) for value in rows[0]):
            raise auth.EvidenceError("Hosted agent telemetry query returned an unexpected shape")
        counts = dict(zip(columns, rows[0]))
        if all(counts[name] for name in required):
            break
    report.inventory["hostedAgentTelemetry"] = counts
    if not counts["AgentRequests"]:
        status_value, detail = "BLOCKED", "No hosted-agent request telemetry arrived on the probe trace."
    elif all(counts[name] for name in required) and not counts["ToolDecisions"]:
        status_value, detail = "PASS", (
            "The probe trace joins the hosted agent's own request telemetry (role manufacturing-agent), its "
            "managed-identity assertion exchange at the selected api-mcp /token and api-mcp's successful /token "
            f"request, with {counts['McpCalls']} /mcp request(s) and no MCP tool authorization decision.")
    else:
        status_value, detail = "FAIL", ("The hosted agent reported on the probe trace without the complete "
                                        "token-exchange path, or an MCP tool was authorized for a no-tool probe.")
    report.add("telemetry:hosted-manufacturing-agent:trace", "telemetry", status_value, detail)


BROWSER_PRODUCERS = {"app-eshop": "APP_URL", "app-admin": "APP_ADMIN_URL", "app-manufacturing": "APP_MANUFACTURING_URL"}


def exercise_telemetry_producers(report, deployment):
    """Deterministically exercise producers that only report when visited, before producers are queried."""
    environment = dict(auth.os.environ)
    for key in BROWSER_PRODUCERS.values():
        environment[key] = auth.https_url(deployment.required(key))
    output = report.output / "frontend-telemetry.json"
    auth.command(["node", "tests/scripts/test-frontend-telemetry.mjs", "--output", str(output)],
                 environment=environment, timeout=240)
    try:
        sites = {item["role"]: item for item in json.loads(output.read_text())["sites"]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise auth.EvidenceError("The frontend telemetry probe returned invalid evidence") from error
    if set(sites) != set(BROWSER_PRODUCERS):
        raise auth.EvidenceError("The frontend telemetry probe did not cover every site")
    for role, site in sites.items():
        accepted = site.get("accepted")
        report.check(f"telemetry:browser:{role}", "telemetry",
                     isinstance(accepted, int) and accepted > 0 and site.get("roleMatches") is True,
                     f"An anonymous {role} page load had browser telemetry accepted by the selected "
                     "Application Insights ingestion endpoint under its own cloud role.")
    trace = uuid.uuid4().hex
    status, _, _ = auth.http("GET", auth.https_url(deployment.required("MCP_INSPECTOR_URL")) + "/health",
                             timeout=60, headers={"traceparent": f"00-{trace}-{uuid.uuid4().hex[:16]}-01"})
    report.check("telemetry:exercise:mcp-inspector", "telemetry", status == 200,
                 f"The MCP Inspector gateway health request returned HTTP {status}; it records request telemetry.")
    report.inventory["telemetryProbe"] = {"browserOperations": {role: site.get("operationIds", [])
                                                                for role, site in sites.items()},
                                          "inspectorTrace": trace}
