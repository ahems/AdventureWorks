using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;
using System.Text.Json;

namespace api_functions.Functions;

public class EmbellishProductsUsingAI
{
    private readonly ILogger<EmbellishProductsUsingAI> _logger;
    private readonly ILoggerFactory _loggerFactory;

    public EmbellishProductsUsingAI(ILogger<EmbellishProductsUsingAI> logger, ILoggerFactory loggerFactory)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
    }

    [Function(nameof(EmbellishProductsUsingAI_HttpStart))]
    public async Task<HttpResponseData> EmbellishProductsUsingAI_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Starting product embellishment orchestration");

        // Parse optional product IDs from request body
        List<int>? productIds = null;
        try
        {
            var requestBody = await req.ReadAsStringAsync();
            if (!string.IsNullOrWhiteSpace(requestBody))
            {
                var payload = JsonSerializer.Deserialize<ProductIdsRequest>(requestBody);
                productIds = payload?.ProductIds;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse request body, processing all products");
        }

        var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(EmbellishProductsUsingAI_Orchestrator),
            productIds);

        _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

        return client.CreateCheckStatusResponse(req, instanceId);
    }

    private class ProductIdsRequest
    {
        public List<int>? ProductIds { get; set; }
    }

    [Function(nameof(EmbellishProductsUsingAI_Orchestrator))]
    public async Task<string> EmbellishProductsUsingAI_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<EmbellishProductsUsingAI>();
        var productIds = context.GetInput<List<int>?>();

        if (productIds?.Count > 0)
        {
            logger.LogInformation("Orchestration started for specific products: {ids}", string.Join(", ", productIds));
        }
        else
        {
            logger.LogInformation("Orchestration started for all products");
        }

        try
        {
            // Step 1: Fetch finished goods products from database
            logger.LogInformation("Fetching products from database");
            var products = await context.CallActivityAsync<List<ProductData>>(
                nameof(FetchProductsActivity),
                productIds);

            logger.LogInformation("Fetched {count} products", products.Count);

            if (products.Count == 0)
            {
                return "No finished goods products found to enhance";
            }

            // Step 2: Enhance products using AI
            logger.LogInformation("Enhancing products with AI");
            var enhancedProducts = await context.CallActivityAsync<List<EnhancedProductData>>(
                nameof(EnhanceProductsWithAIActivity),
                products);

            logger.LogInformation("Enhanced {count} products", enhancedProducts.Count);

            // Step 3: Update database with enhanced data
            logger.LogInformation("Updating database with enhanced products");
            await context.CallActivityAsync(
                nameof(UpdateProductsActivity),
                enhancedProducts);

            // Step 4: Trigger translation of enhanced products
            logger.LogInformation("Triggering translation for {count} enhanced products", enhancedProducts.Count);
            var productModelIds = products
                .Where(p => p.ProductModelID.HasValue)
                .Select(p => p.ProductModelID!.Value)
                .Distinct()
                .ToList();

            if (productModelIds.Count > 0)
            {
                await context.CallSubOrchestratorAsync(
                    "TranslateProductDescriptions_Orchestrator",
                    productModelIds);
            }

            logger.LogInformation("Orchestration completed successfully");
            return $"Successfully enhanced and translated {enhancedProducts.Count} products";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during orchestration");
            throw;
        }
    }

    [Function(nameof(FetchProductsActivity))]
    public async Task<List<ProductData>> FetchProductsActivity(
        [ActivityTrigger] List<int>? productIds)
    {
        if (productIds?.Count > 0)
        {
            _logger.LogInformation("Fetching {count} specific products from database", productIds.Count);
        }
        else
        {
            _logger.LogInformation("Fetching all products from database");
        }

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var products = await productService.GetFinishedGoodsProductsAsync(productIds);

        _logger.LogInformation("Fetched {count} products", products.Count);
        return products;
    }

    [Function(nameof(EnhanceProductsWithAIActivity))]
    public async Task<List<EnhancedProductData>> EnhanceProductsWithAIActivity(
        [ActivityTrigger] List<ProductData> products)
    {
        _logger.LogInformation("Enhancing {count} products with AI", products.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var aiService = new AIService(endpoint, aiServiceLogger);
        var enhancedProducts = await aiService.EnhanceProductsAsync(products);

        _logger.LogInformation("AI enhanced {count} products", enhancedProducts.Count);
        return enhancedProducts;
    }

    [Function(nameof(UpdateProductsActivity))]
    public async Task UpdateProductsActivity(
        [ActivityTrigger] List<EnhancedProductData> enhancedProducts)
    {
        _logger.LogInformation("Updating {count} products in database", enhancedProducts.Count);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);

        foreach (var enhancedProduct in enhancedProducts)
        {
            await productService.UpdateProductAsync(enhancedProduct);
        }

        _logger.LogInformation("Updated {count} products in database", enhancedProducts.Count);
    }
}
