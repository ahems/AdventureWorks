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
/// Enqueues N order-generation jobs onto the chat AI queue for background processing.
/// Each job picks a random persona; for "existing-customer" a random qualifying customer is resolved at execution time.
/// POST /api/GenerateOrdersBulk
/// Body: { "count": 10 }
/// Returns: { "queued": 10, "message": "..." }
/// </summary>
public class GenerateOrdersBulkFunction
{
    private readonly ILogger<GenerateOrdersBulkFunction> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly OrderGenerationService _orderGenService;

    private static readonly string[] RandomPersonas =
    [
        "newbie-male",
        "newbie-female",
        "experienced-male",
        "experienced-female",
        "family-shopper",
        "commuter",
        "mountain-enthusiast",
        "existing-customer"
    ];

    public GenerateOrdersBulkFunction(
        ILogger<GenerateOrdersBulkFunction> logger,
        TelemetryClient telemetryClient,
        OrderGenerationService orderGenService)
    {
        _logger = logger;
        _telemetryClient = telemetryClient;
        _orderGenService = orderGenService;
    }

    [Function("GenerateOrdersBulk")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "GenerateOrdersBulk")] HttpRequestData req)
    {
        _logger.LogInformation("GenerateOrdersBulk request received");

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var input = JsonSerializer.Deserialize<GenerateOrdersBulkRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var count = Math.Clamp(input?.Count ?? 1, 1, 500);

            // Pre-fetch a pool of existing customer IDs so "existing-customer" jobs can be resolved quickly
            List<int> existingCustomerIds = [];
            try
            {
                existingCustomerIds = await _orderGenService.GetCustomerIdsWithOrdersAsync(500);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not fetch existing customer IDs — existing-customer persona may fall back to random");
            }

            var queueClient = await GetChatQueueClientAsync();
            int queued = 0;

            for (int i = 0; i < count; i++)
            {
                var persona = RandomPersonas[Random.Shared.Next(RandomPersonas.Length)];
                int? seedCustomerId = null;

                if (persona == "existing-customer" && existingCustomerIds.Count > 0)
                    seedCustomerId = existingCustomerIds[Random.Shared.Next(existingCustomerIds.Count)];

                var msg = new AiJobMessage
                {
                    JobType = "generate-order",
                    PersonaType = persona,
                    SeedCustomerId = seedCustomerId
                };

                await queueClient.SendMessageAsync(JsonSerializer.Serialize(msg));
                queued++;
            }

            _telemetryClient.TrackEvent("GenerateOrdersBulk.Queued", new Dictionary<string, string>
            {
                ["Count"] = queued.ToString()
            });

            _logger.LogInformation("GenerateOrdersBulk: enqueued {Count} order-generation jobs", queued);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                queued,
                message = $"{queued} order generation job{(queued == 1 ? "" : "s")} queued for background processing."
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateOrdersBulk");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "GenerateOrdersBulk" });
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = ex.Message });
            return errorResponse;
        }
    }

    private static async Task<QueueClient> GetChatQueueClientAsync()
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

        var queueClient = client.GetQueueClient(AIJobProcessorFunction.CHAT_QUEUE);
        return queueClient;
    }
}

public class GenerateOrdersBulkRequest
{
    public int Count { get; set; } = 1;
}
