// AdventureWorks Manufacturing Agent — Foundry Hosted Agent
//
// Triggered by the ManufacturingAgentQueueTrigger Azure Function via the Responses protocol.
// Receives order context, uses server-side MCP tools to analyse inventory and manufacturing
// feasibility, then returns a structured JSON response with findings, tools used, and any
// proposal or action IDs.
//
// Behaviour is controlled by the `mode` field in the incoming message:
//   ReadOnly (1)        — analyse and report only; never take autonomous actions
//   ProposePending (2)  — propose actions via ProposeManufacturingRun / ProposeSupplyOrder
//   FullyAutonomous (3) — execute actions directly via BeginManufacturingRun / PlaceSupplyOrder

#pragma warning disable MEAI001 // HostedMcpServerTool is experimental

using Azure.AI.AgentServer.Core;
using Azure.AI.Projects;
using Azure.Identity;
using DotNetEnv;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;
using Microsoft.Extensions.AI;
using McpTools;
using OpenTelemetry;
using OpenTelemetry.Trace;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Logs;

// Load .env file if present (for local development)
Env.NoClobber().TraversePath().Load();

var projectEndpoint = new Uri(
    Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT is not set."));

var deployment   = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME") ?? "chat";
var mcpServiceUrl = Environment.GetEnvironmentVariable("MCP_SERVICE_URL")
    ?? throw new InvalidOperationException("MCP_SERVICE_URL is not set.");

// ── Server-side MCP: AdventureWorks manufacturing + supply chain tools ────────
// The Foundry Responses API calls the MCP server on behalf of the agent —
// no local MCP connection or tool-call approval loop needed.
HostedMcpServerTool CreateMcpTool(string authorization, string mode) => new(
    serverName: "adventureworks_mcp",
    serverAddress: mcpServiceUrl)
{
    ApprovalMode = HostedMcpServerToolApprovalMode.NeverRequire,
    Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["Authorization"] = authorization
    },
    AllowedTools = McpServiceAuthentication.GetToolsForMode(mode)
};

// ── Agent instructions ────────────────────────────────────────────────────────
const string instructions = """
    You are the AdventureWorks Manufacturing and Supply Chain Agent. You are invoked
    programmatically when a new sales order is placed — not through a user chat interface.

    ## Your input
    Each invocation includes a structured message with:
    - SalesOrderID and CustomerID
    - Mode: ReadOnly | ProposePending | FullyAutonomous
    - RunID (for tracking)
    - Optional StepCallbackUrl (ignore it — step updates are handled externally)

    ## Your workflow
    1. Call get_order_details to retrieve the ordered products and quantities.
    2. For each product, call check_inventory_availability to check current stock.
    3. For products where stock may fall below safe levels, call get_production_feasibility.
    4. For products where manufacturing is not feasible, call get_supply_chain_vendors
       and get_supply_quote to find the best supply option.
    5. In FullyAutonomous mode, call begin_manufacturing_run or place_supply_order for
       each product that needs action. In all other modes skip this step.
    6. Return the JSON response.

    ## Mode behaviour
    **ReadOnly**: Analyse and report. Leave recommendedActions and actionsExecuted as [].
    The findingsSummary must mention specific stock levels found (e.g. "Product #776 has 42 units,
    below the 100-unit safe level.").

    **ProposePending**: Analyse and populate recommendedActions with the specific
    actions you recommend. Include productId, qty, vendorId (if supply order), and
    a brief rationale for each. The calling system will create the proposals from
    your recommendations — you do NOT need to call any action tools.

    **FullyAutonomous**: Call begin_manufacturing_run or place_supply_order directly.
    IMPORTANT: Always pass confirmed=true when calling begin_manufacturing_run
    to bypass the interactive confirmation prompt.
    For each action, record a single structured entry in actionsExecuted.

    Manufacturing entry format (extract all values from the begin_manufacturing_run response):
      "WO #<Root Work Order ID>: Started <qty>x <Product Name> (Product #<productId>) — <Total Work Orders Created> work orders, due <dueDate>"

    Supply entry format (extract all values from the place_supply_order response):
      "PO #<Order ID>: Ordered <qty>x <Product Name> (Product #<productId>) from <Vendor Name> (Vendor #<vendorId>) — $<totalCost>, ETA <expectedDeliveryDate>"

    IMPORTANT for supply orders: Before calling place_supply_order, call get_supply_quote to confirm:
    - The qty you request is >= Min order qty shown in the quote (e.g. if min is 100, order at least 100)
    - Stock available >= your qty
    Use the Min order qty from the quote as your order quantity when stock allows.

    The findingsSummary in FullyAutonomous mode must read like an operational log, e.g.:
      "Order #83613 for Customer #35919. Product #776 (Mountain Bike Frame) had 42 units
       remaining — below safe threshold. WO #12345 started to produce 50 units. Component
       #316 (BB Ball Bearing) had 0 units; PO #67890 placed with Vendor #1492 (Hi-Quality
       Components) for 200 units at $450.00, ETA 2026-07-26."

    ## Output format
    Return a JSON object (and ONLY a JSON object — no surrounding text) with:
    {
      "findingsSummary": "<specific operational narrative with product IDs, stock levels, WO/PO numbers>",
      "toolsUsed": ["<actual tools you called — do not invent>"],
      "recommendedActions": [
        {"type": "manufacturing", "productId": 123, "qty": 50, "rationale": "stock below threshold"},
        {"type": "supply", "vendorId": "1", "productId": 316, "qty": 100, "rationale": "manufacturing not feasible"}
      ],
      "actionsExecuted": [
        "WO #12345: Started 50x Mountain Bike Frame (Product #776) — 4 work orders, due 2026-07-28",
        "PO #67890: Ordered 200x BB Ball Bearing (Product #316) from Hi-Quality Components (Vendor #1492) — $450.00, ETA 2026-07-26"
      ]
    }
    recommendedActions is non-empty only in ProposePending mode.
    actionsExecuted is non-empty only in FullyAutonomous mode.

    ## Guidelines
    - Always use live tool data — never invent IDs, names, stock levels, or vendor quotes.
    - Every WO # and PO # in actionsExecuted MUST be the actual ID from the tool response.
    - toolsUsed must list only the tools you actually called during this invocation.
    - Be specific: "Product #776 had 42 units" not "stock was low".
    - If a required tool is unavailable or returns an error, return ONLY
      {"error":{"code":"tool_failure"}}. Never return successful findings or actions for a failed analysis.
    - This is a demo environment — be conservative with autonomous actions.
    """;

// ── Build the agent ───────────────────────────────────────────────────────────
var credential = new DefaultAzureCredential();
// Do not follow redirects with managed-identity assertions or log token response bodies.
using var authHttp = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
var mcpAuthentication = new McpServiceAuthentication(credential, authHttp, mcpServiceUrl);
AIAgent agent = new AIProjectClient(projectEndpoint, credential)
    .AsAIAgent(
        model: deployment,
        instructions: instructions,
        name: "manufacturing-agent",
        description: "Autonomous manufacturing and supply chain agent triggered when new orders are placed.")
    .AsBuilder()
    .UseOpenTelemetry(sourceName: "AdventureWorks.ManufacturingAgent",
        configure: telemetry => telemetry.EnableSensitiveData = false)
    .Use(async (messages, session, options, next, cancellationToken) =>
    {
        var mode = McpServiceAuthentication.GetModeFromMessages(messages.Select(message => message.Text));

        // Resolve narrowly scoped authentication per invocation, never at startup or on a shared tool.
        var authorization = await mcpAuthentication.GetTokenAsync(mode, cancellationToken);
        var runOptions = options is ChatClientAgentRunOptions chatOptions
            ? (ChatClientAgentRunOptions)chatOptions.Clone()
            : new ChatClientAgentRunOptions
            {
                ContinuationToken = options?.ContinuationToken,
                AllowBackgroundResponses = options?.AllowBackgroundResponses,
                AdditionalProperties = options?.AdditionalProperties?.Clone(),
                ResponseFormat = options?.ResponseFormat
            };
        runOptions.ChatOptions = runOptions.ChatOptions?.Clone() ?? new ChatOptions();
        runOptions.ChatOptions.Tools = [CreateMcpTool(authorization, mode)];
        await next(messages, session, runOptions, cancellationToken);
    })
    .Build();

var builder = AgentHost.CreateBuilder(args);
builder.WebApplicationBuilder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
builder.WebApplicationBuilder.Logging.AddFilter("Azure", LogLevel.Warning);
builder.WebApplicationBuilder.Logging.AddConsole(options =>
{
    options.FormatterName = "adventureworks-safe";
    options.LogToStandardErrorThreshold = LogLevel.Trace;
}).AddConsoleFormatter<AdventureWorks.Telemetry.SafeConsoleFormatter, Microsoft.Extensions.Logging.Console.ConsoleFormatterOptions>();
// AgentHost already owns export. Extend its provider and the agent pipeline, not a second distro.
builder.ConfigureTracing(tracing => tracing.AddSource("AdventureWorks.ManufacturingAgent",
    "Experimental.Microsoft.Extensions.AI", "Microsoft.Extensions.AI*", "Azure.*", "OpenAI*", "Experimental.OpenAI*")
    .AddProcessor(new AdventureWorks.Telemetry.TelemetryPrivacyProcessor()));
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource.AddService("manufacturing-agent"))
    .WithMetrics(metrics => metrics.AddMeter("AdventureWorks.ManufacturingAgent",
        "Experimental.Microsoft.Extensions.AI", "Microsoft.Extensions.AI*", "AdventureWorks.Telemetry").AddRuntimeInstrumentation());
builder.Services.ConfigureOpenTelemetryLoggerProvider(logging =>
    logging.AddProcessor(new AdventureWorks.Telemetry.TelemetryLogPrivacyProcessor()));
builder.Services.AddHostedService<AdventureWorks.Telemetry.ExporterDiagnostics>();
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
