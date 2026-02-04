using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.ApplicationInsights;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

public class TranslateProductDescriptions
{
    private readonly ILogger<TranslateProductDescriptions> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IServiceProvider _serviceProvider;

    public TranslateProductDescriptions(ILogger<TranslateProductDescriptions> logger, ILoggerFactory loggerFactory, IServiceProvider serviceProvider)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
        _serviceProvider = serviceProvider;
    }

    [Function(nameof(TranslateProductDescriptions_HttpStart))]
    public async Task<HttpResponseData> TranslateProductDescriptions_HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Starting product translation orchestration");

        // Read product model IDs from request body (optional - if empty, uses recently enhanced)
        List<int>? productModelIds = null;
        try
        {
            productModelIds = await req.ReadFromJsonAsync<List<int>>();
            if (productModelIds != null && productModelIds.Count > 0)
            {
                _logger.LogInformation("Received {count} product model IDs to translate", productModelIds.Count);
            }
        }
        catch
        {
            // If parsing fails or body is empty, productModelIds remains null (will use recently enhanced)
            _logger.LogInformation("No product model IDs provided, will use recently enhanced products");
        }

        var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
            nameof(TranslateProductDescriptions_Orchestrator),
            productModelIds);

        _logger.LogInformation("Started orchestration with ID = '{instanceId}'", instanceId);

        var response = req.CreateResponse(System.Net.HttpStatusCode.Accepted);
        await response.WriteAsJsonAsync(new { id = instanceId, statusQueryGetUri = $"{req.Url.Scheme}://{req.Url.Authority}/runtime/webhooks/durabletask/instances/{instanceId}" });
        return response;
    }

    [Function(nameof(TranslateProductDescriptions_Orchestrator))]
    public async Task<string> TranslateProductDescriptions_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<TranslateProductDescriptions>();

        try
        {
            // Step 1: Fetch products to translate
            // If productModelIds are provided as input, fetch those specific products
            // Otherwise, fetch recently enhanced products
            var productModelIds = context.GetInput<List<int>?>();

            logger.LogInformation(productModelIds != null && productModelIds.Count > 0
                ? $"Fetching {productModelIds.Count} specific products for translation"
                : "Fetching recently enhanced products");

            var recentProducts = await context.CallActivityAsync<List<TranslationRequest>>(
                nameof(FetchRecentlyEnhancedProductsActivity),
                productModelIds);

            if (recentProducts == null || recentProducts.Count == 0)
            {
                return productModelIds != null && productModelIds.Count > 0
                    ? $"No products found for ProductModelIds: {string.Join(", ", productModelIds)}"
                    : "No recently enhanced products found for translation";
            }

            logger.LogInformation("Found {count} products to translate", recentProducts.Count);

            // Step 2: Get supported cultures (all except English)
            logger.LogInformation("Fetching supported cultures");
            var cultures = await context.CallActivityAsync<List<CultureInfo>>(
                nameof(GetSupportedCulturesActivity));

            logger.LogInformation("Found {count} target languages", cultures.Count);

            // Step 3: Translate and save each product individually
            int totalTranslations = 0;
            foreach (var product in recentProducts)
            {
                logger.LogInformation("Translating product {ProductModelID}", product.ProductModelID);

                var translations = await context.CallActivityAsync<List<TranslatedDescription>>(
                    nameof(TranslateSingleProductActivity),
                    (object)new TranslationActivityInput
                    {
                        Products = new List<TranslationRequest> { product },
                        Cultures = cultures
                    });

                logger.LogInformation("Generated {count} translations for product {ProductModelID}",
                    translations.Count, product.ProductModelID);

                if (translations.Count > 0)
                {
                    logger.LogInformation("Saving {count} translations for product {ProductModelID}",
                        translations.Count, product.ProductModelID);

                    await context.CallActivityAsync(
                        nameof(SaveTranslationsActivity),
                        translations);

                    totalTranslations += translations.Count;
                }
            }

            return $"Successfully translated {recentProducts.Count} products into {cultures.Count} languages ({totalTranslations} total translations)";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Translation orchestration failed");
            throw;
        }
    }

    [Function(nameof(FetchRecentlyEnhancedProductsActivity))]
    public async Task<List<TranslationRequest>> FetchRecentlyEnhancedProductsActivity(
        [ActivityTrigger] List<int>? productModelIds)
    {
        _logger.LogInformation(productModelIds != null && productModelIds.Count > 0
            ? $"Fetching specific products: {string.Join(", ", productModelIds)}"
            : "Fetching recently enhanced products from database");

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var products = productModelIds != null && productModelIds.Count > 0
            ? await productService.GetProductsByModelIdsAsync(productModelIds)
            : await productService.GetRecentlyEnhancedProductsAsync();

        _logger.LogInformation("Fetched {count} recently enhanced products", products.Count);
        return products;
    }

    [Function(nameof(GetSupportedCulturesActivity))]
    public async Task<List<CultureInfo>> GetSupportedCulturesActivity(
        [ActivityTrigger] FunctionContext context)
    {
        _logger.LogInformation("Fetching supported cultures from database");

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        var cultures = await productService.GetSupportedCulturesAsync();

        _logger.LogInformation("Found {count} supported cultures", cultures.Count);
        return cultures;
    }

    [Function(nameof(TranslateSingleProductActivity))]
    public async Task<List<TranslatedDescription>> TranslateSingleProductActivity(
        [ActivityTrigger] object input)
    {
        // Deserialize the input which is an anonymous type with Product and Cultures
        var json = System.Text.Json.JsonSerializer.Serialize(input);
        var data = System.Text.Json.JsonSerializer.Deserialize<TranslationActivityInput>(json);

        if (data == null || data.Products == null || data.Products.Count == 0)
        {
            _logger.LogWarning("No product provided for translation");
            return new List<TranslatedDescription>();
        }

        var product = data.Products[0];
        _logger.LogInformation("Translating product {ProductModelID} ({ProductName}) to {cultureCount} languages",
            product.ProductModelID, product.ProductName, data.Cultures.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var telemetryClient = _serviceProvider.GetRequiredService<TelemetryClient>();
        var aiService = new AIService(endpoint, aiServiceLogger, telemetryClient);

        // Translate just this one product
        var translations = await aiService.TranslateProductAsync(product, data.Cultures);

        _logger.LogInformation("AI translated product {ProductModelID} to {count} languages",
            product.ProductModelID, translations.Count);
        return translations;
    }

    [Function(nameof(TranslateDescriptionsActivity))]
    public async Task<List<TranslatedDescription>> TranslateDescriptionsActivity(
        [ActivityTrigger] TranslationActivityInput input)
    {
        _logger.LogInformation("Translating {productCount} products to {cultureCount} languages",
            input.Products.Count, input.Cultures.Count);

        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");

        var aiServiceLogger = _loggerFactory.CreateLogger<AIService>();
        var telemetryClient = _serviceProvider.GetRequiredService<TelemetryClient>();
        var aiService = new AIService(endpoint, aiServiceLogger, telemetryClient);
        var translations = await aiService.TranslateDescriptionsAsync(input.Products, input.Cultures);

        _logger.LogInformation("AI translated {count} descriptions", translations.Count);
        return translations;
    }

    [Function(nameof(SaveTranslationsActivity))]
    public async Task SaveTranslationsActivity(
        [ActivityTrigger] List<TranslatedDescription> translations)
    {
        _logger.LogInformation("Saving {count} translations to database", translations.Count);

        var connectionString = Environment.GetEnvironmentVariable("SQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING not configured");

        var productService = new ProductService(connectionString);
        await productService.SaveTranslationsAsync(translations);

        _logger.LogInformation("Saved {count} translations", translations.Count);
    }
}
