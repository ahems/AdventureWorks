using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;
using Azure.Storage.Queues;
using Azure.Identity;
using System.Net;

namespace api_functions.Functions;

public class TranslateProductDescriptions
{
    private readonly ILogger<TranslateProductDescriptions> _logger;
    private const string AI_JOB_QUEUE = "ai-job-chat-queue";

    public TranslateProductDescriptions(ILogger<TranslateProductDescriptions> logger)
    {
        _logger = logger;
    }

    [Function(nameof(TranslateProductDescriptions_HttpStart))]
    public async Task<HttpResponseData> TranslateProductDescriptions_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("Translation request: enqueuing translation jobs onto ai-job-chat-queue");

        // Read optional product model IDs from request body
        List<int>? productModelIds = null;
        try
        {
            var bodyText = await req.ReadAsStringAsync();
            if (!string.IsNullOrWhiteSpace(bodyText))
            {
                var bodyElement = JsonSerializer.Deserialize<JsonElement>(bodyText);
                if (bodyElement.ValueKind == JsonValueKind.Array)
                    productModelIds = bodyElement.Deserialize<List<int>>();
                else if (bodyElement.ValueKind == JsonValueKind.Object &&
                         bodyElement.TryGetProperty("ProductModelIds", out var prop))
                    productModelIds = prop.Deserialize<List<int>>();
            }
        }
        catch
        {
            _logger.LogInformation("No product model IDs provided — will use recently enhanced products");
        }

        try
        {
            // Resolve which product models to translate
            var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
                ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");
            var productService = new ProductService(connectionString);

            var products = productModelIds?.Count > 0
                ? await productService.GetProductsByModelIdsAsync(productModelIds)
                : await productService.GetRecentlyEnhancedProductsAsync();

            if (products == null || products.Count == 0)
            {
                var emptyResponse = req.CreateResponse(HttpStatusCode.OK);
                await emptyResponse.WriteAsJsonAsync(new QueuedJobResponseDto
                {
                    Id = Guid.NewGuid().ToString(),
                    Message = "No products found for translation"
                });
                return emptyResponse;
            }

            // Build queue client
            var queueServiceUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
            if (string.IsNullOrEmpty(queueServiceUri))
            {
                var storageAccountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName")
                    ?? throw new InvalidOperationException("AzureWebJobsStorage__accountName not found");
                queueServiceUri = $"https://{storageAccountName}.queue.core.windows.net";
            }
            var queueServiceClient = new QueueServiceClient(
                new Uri(queueServiceUri),
                new DefaultAzureCredential(),
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });

            var aiJobQueueClient = queueServiceClient.GetQueueClient(AI_JOB_QUEUE);

            // Enqueue one translation job per product model
            int enqueued = 0;
            foreach (var product in products)
            {
                var message = JsonSerializer.Serialize(new AiJobMessage
                {
                    JobType = "translation",
                    ProductModelId = product.ProductModelID,
                    // Pass ProductID so name translation is also performed
                    ProductId = product.ProductID > 0 ? product.ProductID : null
                });
                await aiJobQueueClient.SendObservedMessageAsync(message);
                enqueued++;
            }

            _logger.LogInformation("Enqueued {count} translation jobs onto {queue}", enqueued, AI_JOB_QUEUE);

            var jobId = Guid.NewGuid().ToString();
            var successResponse = req.CreateResponse(HttpStatusCode.Accepted);
            // Return the same shape the admin UI expects for a queued (non-Durable) job
            await successResponse.WriteAsJsonAsync(new QueuedJobResponseDto
            {
                Id = jobId,
                Message = $"Enqueued {enqueued} translation jobs. They will be processed serially."
            });
            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error enqueueing translation jobs");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    // ── DTO returned to admin UI ─────────────────────────────────────────────
    private class QueuedJobResponseDto
    {
        public string Id { get; set; } = string.Empty;
        public string? Message { get; set; }
        // statusQueryGetUri intentionally omitted → frontend treats as queued/done
    }
}
