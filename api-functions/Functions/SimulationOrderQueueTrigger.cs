using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using api_functions.Models;
using api_functions.Services;
using Azure.Identity;
using Azure.Storage.Queues;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// Autonomous AI order simulation driven by the <c>simulation-order-queue</c> queue.
///
/// Message routing:
///   CustomerId == 0  → agent generates an order for a random (or hinted) persona
///   CustomerId  > 0  → agent generates the next realistic purchase for that specific customer
///
/// The function also exposes an HTTP trigger at <c>POST /api/simulation/orders/start</c>
/// which enqueues one or more simulation messages in batch — useful for seeding demo data
/// or load-testing without going through the admin UI.
///
/// Scale-out:
///   KEDA watches the queue with <c>queueLength: 5</c>; the Container App scales out to
///   <c>maxReplica</c> instances as the queue fills, processing each order in parallel.
/// </summary>
public class SimulationOrderQueueTrigger
{
    internal const string QUEUE_NAME = "simulation-order-queue";

    internal static readonly string[] RandomPersonas =
    [
        "newbie-male",
        "newbie-female",
        "experienced-male",
        "experienced-female",
        "family-shopper",
        "commuter",
        "mountain-enthusiast",
    ];

    private readonly ILogger<SimulationOrderQueueTrigger> _logger;
    private readonly OrderGenerationAgentService _agentService;
    private readonly TelemetryClient _telemetryClient;
    private readonly ShoppingSimulatorService _simulator;

    public SimulationOrderQueueTrigger(
        ILogger<SimulationOrderQueueTrigger> logger,
        OrderGenerationAgentService agentService,
        TelemetryClient telemetryClient,
        ShoppingSimulatorService simulator)
    {
        _logger = logger;
        _agentService = agentService;
        _telemetryClient = telemetryClient;
        _simulator = simulator;
    }

    // ── Queue trigger ────────────────────────────────────────────────────────

    /// <summary>
    /// Processes a single simulation-order message from the queue.
    /// Runs fully autonomously — no HTTP round-trip required.
    /// </summary>
    [Function(nameof(SimulationOrder_QueueTrigger))]
    public async Task SimulationOrder_QueueTrigger(
        [QueueTrigger(QUEUE_NAME, Connection = "AzureWebJobsStorage")] BinaryData queueMessage,
        FunctionContext executionContext)
    {
        SimulationOrderMessage? msg = null;
        try
        {
            msg = JsonSerializer.Deserialize<SimulationOrderMessage>(
                queueMessage.ToString(),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[simulation-order-queue] Failed to deserialise message — dropping");
            return; // Poison message: let it dead-letter rather than retry indefinitely
        }

        if (msg == null)
        {
            _logger.LogWarning("[simulation-order-queue] Null message after deserialisation — dropping");
            return;
        }

        // ── Resolve the effective OrderMode for routing ─────────────────────
        var orderMode = msg.OrderMode;
        if (string.IsNullOrWhiteSpace(orderMode))
        {
            // Legacy message: infer mode from CustomerId
            orderMode = msg.CustomerId > 0 ? "existing-repeat" : "new-persona";
        }

        // ── Determine persona and seed customer ─────────────────────────────
        string personaType;
        int? seedCustomerId = null;
        string? orderType = "consumer";

        switch (orderMode)
        {
            case "b2b-store":
                personaType = "b2b-store";
                orderType = "b2b-store";
                _logger.LogInformation("[simulation-order-queue] Processing B2B STORE order for StoreId={StoreId}", msg.StoreId);
                break;

            case "no-order-customer":
                personaType = "sale-seeker";
                seedCustomerId = msg.CustomerId > 0 ? msg.CustomerId : null;
                orderType = "no-order-customer";
                _logger.LogInformation("[simulation-order-queue] Processing NO-ORDER customer {CustomerId} (drawn to sale items)", msg.CustomerId);
                break;

            case "cart-recovery":
                personaType = "cart-recovery";
                seedCustomerId = msg.CustomerId > 0 ? msg.CustomerId : null;
                orderType = "cart-recovery";
                _logger.LogInformation("[simulation-order-queue] Processing CART-RECOVERY for customer {CustomerId}", msg.CustomerId);
                break;

            case "existing-repeat":
                personaType = "existing-customer";
                seedCustomerId = msg.CustomerId > 0 ? msg.CustomerId : null;
                _logger.LogInformation("[simulation-order-queue] Processing EXISTING customer {CustomerId}", msg.CustomerId);
                break;

            case "new-persona":
            default:
                personaType = !string.IsNullOrWhiteSpace(msg.PersonaHint)
                    ? msg.PersonaHint.Trim()
                    : RandomPersonas[Random.Shared.Next(RandomPersonas.Length)];
                _logger.LogInformation("[simulation-order-queue] Processing NEW customer persona={Persona}", personaType);
                break;
        }

        var trackProps = new Dictionary<string, string>
        {
            ["PersonaType"]    = personaType,
            ["CustomerId"]     = (seedCustomerId?.ToString() ?? "0"),
            ["PersonaHint"]    = msg.PersonaHint ?? "",
            ["OrderMode"]      = orderMode,
            ["StoreId"]        = (msg.StoreId?.ToString() ?? ""),
            ["QueueSource"]    = QUEUE_NAME
        };

        try
        {
            var result = await _agentService.GenerateOrderAsync(
                personaType,
                customPersona: null,
                seedCustomerId: seedCustomerId,
                orderMode: orderMode,
                storeId: msg.StoreId);

            if (result.Success)
            {
                _logger.LogInformation("[simulation-order-queue] Order #{OrderId} created for {Customer} (total: ${Total:F2})",
                    result.SalesOrderId, result.CustomerName, result.TotalDue);

                _telemetryClient.TrackEvent("SimulationOrder.Success", new Dictionary<string, string>(trackProps)
                {
                    ["SalesOrderId"]  = result.SalesOrderId.ToString(),
                    ["CustomerName"]  = result.CustomerName ?? "",
                    ["NewCustomer"]   = result.NewCustomerCreated.ToString(),
                    ["TotalDue"]      = result.TotalDue.ToString("F2")
                });

                await _simulator.SaveResultAsync(new Models.SimulationOrderResultEntity
                {
                    RowKey = Models.SimulationOrderResultEntity.GenerateRowKey(DateTimeOffset.UtcNow),
                    Success = true,
                    SalesOrderId = result.SalesOrderId,
                    CustomerId = result.CustomerId,
                    CustomerName = result.CustomerName,
                    NewCustomerCreated = result.NewCustomerCreated,
                    TotalDue = (double)result.TotalDue,
                    PersonaType = personaType,
                    AiReasoning = result.Log.FirstOrDefault(l => l.Type == "success")?.Message
                        ?? result.Log.LastOrDefault()?.Message,
                    ItemCount = result.Log.Count(l => l.Message.Contains("product", StringComparison.OrdinalIgnoreCase)),
                    CompletedAt = DateTimeOffset.UtcNow,
                    OrderType = orderType,
                });
            }
            else
            {
                _logger.LogWarning("[simulation-order-queue] Order generation failed — {Error}", result.ErrorMessage);
                _telemetryClient.TrackEvent("SimulationOrder.Failed", new Dictionary<string, string>(trackProps)
                {
                    ["Error"] = result.ErrorMessage ?? "unknown"
                });

                await _simulator.SaveResultAsync(new Models.SimulationOrderResultEntity
                {
                    RowKey = Models.SimulationOrderResultEntity.GenerateRowKey(DateTimeOffset.UtcNow),
                    Success = false,
                    FailureCode = result.FailureCode,
                    ErrorMessage = result.ErrorMessage,
                    PersonaType = personaType,
                    CompletedAt = DateTimeOffset.UtcNow,
                    OrderType = orderType,
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[simulation-order-queue] Unhandled error for persona={Persona} customerId={CustomerId}",
                personaType, seedCustomerId);
            _telemetryClient.TrackException(ex, trackProps);
            throw; // Re-throw so the Functions runtime can retry / dead-letter
        }
    }

    // ── HTTP trigger: batch enqueue ──────────────────────────────────────────

    /// <summary>
    /// Enqueues one or more simulation-order messages.
    /// POST /api/simulation/orders/start
    /// Body: { "count": 5, "customerId": 0 }
    ///   count      — number of messages to enqueue (1–500, default 1)
    ///   customerId — 0 = random personas (default), positive ID = that specific customer for every message
    ///   personaHint — optional persona hint when customerId == 0
    /// </summary>
    [Function("SimulationOrder_HttpStart")]
    public async Task<HttpResponseData> SimulationOrder_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "simulation/orders/start")] HttpRequestData req)
    {
        _logger.LogInformation("SimulationOrder_HttpStart: batch enqueue request received");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var input = JsonSerializer.Deserialize<SimulationOrderStartRequest>(
                body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var count      = Math.Clamp(input?.Count ?? 1, 1, 500);
            var customerId = input?.CustomerId ?? 0;
            var personaHint = input?.PersonaHint;

            var queueClient = await GetSimulationQueueClientAsync();
            int queued = 0;

            for (int i = 0; i < count; i++)
            {
                var msg = new SimulationOrderMessage
                {
                    CustomerId  = customerId,
                    PersonaHint = personaHint
                };
                await queueClient.SendMessageAsync(JsonSerializer.Serialize(msg));
                queued++;
            }

            _telemetryClient.TrackEvent("SimulationOrder.Enqueued", new Dictionary<string, string>
            {
                ["Count"]      = queued.ToString(),
                ["CustomerId"] = customerId.ToString()
            });

            _logger.LogInformation("SimulationOrder_HttpStart: enqueued {Count} messages", queued);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                queued,
                message = $"{queued} simulation order message{(queued == 1 ? "" : "s")} enqueued."
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in SimulationOrder_HttpStart");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "SimulationOrder_HttpStart" });
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = ex.Message });
            return err;
        }
    }

    // ── Queue client helper ──────────────────────────────────────────────────

    private static async Task<QueueClient> GetSimulationQueueClientAsync()
    {
        var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        if (string.IsNullOrEmpty(queueServiceUri))
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not configured");
            queueServiceUri = $"https://{accountName}.queue.core.windows.net";
        }

        var client = new QueueServiceClient(
            new Uri(queueServiceUri),
            new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

        var queueClient = client.GetQueueClient(QUEUE_NAME);
        await queueClient.CreateIfNotExistsAsync();
        return queueClient;
    }
}

/// <summary>Request body for <see cref="SimulationOrderQueueTrigger.SimulationOrder_HttpStart"/>.</summary>
public class SimulationOrderStartRequest
{
    public int Count { get; set; } = 1;
    public int CustomerId { get; set; } = 0;
    public string? PersonaHint { get; set; }
}
