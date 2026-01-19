using System.ComponentModel;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// AdventureWorks MCP Tools - Provides AI agents with tools to query AdventureWorks data
/// Implements standard MCP protocol with SSE transport support
/// </summary>
[McpServerToolType]
public class AdventureWorksMcpTools
{
    private readonly OrderService _orderService;
    private readonly ProductService _productService;
    private readonly ReviewService _reviewService;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    public AdventureWorksMcpTools(
        OrderService orderService,
        ProductService productService,
        ReviewService reviewService,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _orderService = orderService;
        _productService = productService;
        _reviewService = reviewService;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    [McpServerTool]
    [Description("Get order history and status for a customer by their CustomerID. Returns up to 10 most recent orders with status information. Supports multiple languages.")]
    public async Task<string> GetCustomerOrders(int customerId, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetCustomerOrders");
        operation.Telemetry.Properties["customerId"] = customerId.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _orderService.GetCustomerOrderStatusAsync(customerId, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetCustomerOrders" },
                { "customerId", customerId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetCustomerOrders" },
                { "customerId", customerId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get detailed information about a specific order including items, pricing, and shipping status. Optional: Validates order belongs to customer. Supports multiple languages.")]
    public async Task<string> GetOrderDetails(int orderId, int? customerId = null, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetOrderDetails");
        operation.Telemetry.Properties["orderId"] = orderId.ToString();
        if (customerId.HasValue)
            operation.Telemetry.Properties["customerId"] = customerId.Value.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _orderService.GetOrderDetailsAsync(orderId, customerId, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetOrderDetails" },
                { "orderId", orderId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetOrderDetails" },
                { "orderId", orderId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Find products that are frequently purchased together with a specific product. Great for product recommendations. Supports multiple languages.")]
    public async Task<string> FindComplementaryProducts(int productId, int limit = 5, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_FindComplementaryProducts");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        operation.Telemetry.Properties["limit"] = limit.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _orderService.FindComplementaryProductsAsync(productId, limit, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "FindComplementaryProducts" },
                { "productId", productId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "FindComplementaryProducts" },
                { "productId", productId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Search for products by name, category, or attributes. Returns matching products with details. Supports multiple languages: ar, en (default), es, fr, he, th, zh-cht, en-gb, en-ca, en-au, ja, ko, de.")]
    public async Task<string> SearchProducts(string searchTerm, string? cultureId = null, int? categoryId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_SearchProducts");
        operation.Telemetry.Properties["searchTerm"] = searchTerm;
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";
        if (categoryId.HasValue)
            operation.Telemetry.Properties["categoryId"] = categoryId.Value.ToString();

        try
        {
            // Default to English if not specified
            var culture = cultureId ?? "en";

            // Generate embedding for the search query
            var queryEmbedding = await _aiService.GenerateQueryEmbeddingAsync(searchTerm);

            // Search both descriptions and reviews in parallel
            // Both already filter for FinishedGoodsFlag = true
            var descriptionSearchTask = _productService.SearchProductsByDescriptionEmbeddingAsync(queryEmbedding, 10, culture);
            var reviewSearchTask = _reviewService.SearchProductsByReviewEmbeddingAsync(queryEmbedding, 10, culture);

            await Task.WhenAll(descriptionSearchTask, reviewSearchTask);

            var descriptionResults = await descriptionSearchTask;
            var reviewResults = await reviewSearchTask;

            // Combine and deduplicate results, keeping the best match per product
            var combinedResults = new Dictionary<int, (string Name, decimal? Price, string? Description, string? Category, double Score, string Source, string? MatchText)>();

            foreach (var descResult in descriptionResults)
            {
                combinedResults[descResult.ProductID] = (
                    descResult.Name,
                    descResult.ListPrice,
                    descResult.Description,
                    descResult.ProductCategoryName,
                    descResult.SimilarityScore,
                    "Description",
                    descResult.Description
                );
            }

            foreach (var reviewResult in reviewResults)
            {
                if (!combinedResults.ContainsKey(reviewResult.ProductID) ||
                    reviewResult.SimilarityScore < combinedResults[reviewResult.ProductID].Score)
                {
                    combinedResults[reviewResult.ProductID] = (
                        reviewResult.Name,
                        reviewResult.ListPrice,
                        reviewResult.Description,
                        null,
                        reviewResult.SimilarityScore,
                        "Review",
                        reviewResult.MatchText
                    );
                }
            }

            if (!combinedResults.Any())
            {
                return $"No products found matching '{searchTerm}'";
            }

            // Sort by similarity score (lower is better for distance)
            var sortedResults = combinedResults
                .OrderBy(r => r.Value.Score)
                .Take(10)
                .ToList();

            var result = new System.Text.StringBuilder();
            result.AppendLine($"Found {sortedResults.Count} products matching '{searchTerm}' (using semantic search on descriptions and reviews):");
            result.AppendLine();

            foreach (var item in sortedResults)
            {
                var (name, price, description, category, score, source, matchText) = item.Value;

                result.AppendLine($"{name} (ID: {item.Key})");
                if (!string.IsNullOrEmpty(category))
                {
                    result.AppendLine($"  Category: {category}");
                }
                result.AppendLine($"  Price: ${price:N2}");
                result.AppendLine($"  Match: Found in {source}");

                if (!string.IsNullOrEmpty(matchText))
                {
                    var shortText = matchText.Length > 100
                        ? matchText.Substring(0, 97) + "..."
                        : matchText;
                    result.AppendLine($"  {(source == "Review" ? "Review" : "Description")}: {shortText}");
                }

                result.AppendLine($"  Relevance: {(1 - score):P1}"); // Convert distance to similarity percentage
                result.AppendLine();
            }

            var resultString = result.ToString();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
        {
            { "tool", "SearchProducts" },
            { "searchTerm", searchTerm },
            { "resultsCount", sortedResults.Count.ToString() },
            { "resultLength", resultString.Length.ToString() }
        });
            return resultString;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "SearchProducts" },
                { "searchTerm", searchTerm }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get detailed information about a specific product including specifications, pricing, and inventory.")]
    public async Task<string> GetProductDetails(int productId)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetProductDetails");
        operation.Telemetry.Properties["productId"] = productId.ToString();

        try
        {
            var products = await _productService.GetFinishedGoodsProductsAsync(new List<int> { productId });

            if (!products.Any())
            {
                var notFoundResult = $"Product ID {productId} not found";
                operation.Telemetry.Success = true;
                operation.Telemetry.Properties["found"] = "false";
                return notFoundResult;
            }

            var product = products.First();
            var result = new System.Text.StringBuilder();

            result.AppendLine($"{product.Name}");
            result.AppendLine($"Product Number: {product.ProductNumber}");
            result.AppendLine($"Category: {product.ProductCategoryName} / {product.ProductSubcategoryName}");
            result.AppendLine($"Price: ${product.ListPrice:N2}");

            if (!string.IsNullOrEmpty(product.Color))
                result.AppendLine($"Color: {product.Color}");

            if (!string.IsNullOrEmpty(product.Size))
                result.AppendLine($"Size: {product.Size}");

            if (product.Weight.HasValue)
                result.AppendLine($"Weight: {product.Weight} {product.WeightUnitMeasureCode}");

            if (!string.IsNullOrEmpty(product.Description))
            {
                result.AppendLine();
                result.AppendLine("Description:");
                result.AppendLine(product.Description);
            }

            var resultString = result.ToString();
            operation.Telemetry.Success = true;
            operation.Telemetry.Properties["found"] = "true";
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetProductDetails" },
                { "productId", productId.ToString() },
                { "resultLength", resultString.Length.ToString() }
            });
            return resultString;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetProductDetails" },
                { "productId", productId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like. Supports multiple languages.")]
    public async Task<string> GetPersonalizedRecommendations(int customerId, int limit = 5, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetPersonalizedRecommendations");
        operation.Telemetry.Properties["customerId"] = customerId.ToString();
        operation.Telemetry.Properties["limit"] = limit.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _orderService.GetPersonalizedRecommendationsAsync(customerId, limit, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetPersonalizedRecommendations" },
                { "customerId", customerId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetPersonalizedRecommendations" },
                { "customerId", customerId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback. Supports multiple languages.")]
    public async Task<string> AnalyzeProductReviews(int productId, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_AnalyzeProductReviews");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _reviewService.AnalyzeProductReviewsAsync(productId, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "AnalyzeProductReviews" },
                { "productId", productId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "AnalyzeProductReviews" },
                { "productId", productId.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Check real-time inventory availability for a product in finished goods locations. Returns stock levels, finished goods storage locations, and availability status. Supports multiple languages.")]
    public async Task<string> CheckInventoryAvailability(int productId, string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_CheckInventoryAvailability");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        try
        {
            var result = await _productService.CheckInventoryAvailabilityAsync(productId, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "CheckInventoryAvailability" },
                { "productId", productId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "CheckInventoryAvailability" },
                { "productId", productId.ToString() }
            });
            throw;
        }
    }
}
