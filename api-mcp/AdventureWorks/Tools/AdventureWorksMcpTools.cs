using System.ComponentModel;
using AdventureWorks.Services;
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

    public AdventureWorksMcpTools(
        OrderService orderService,
        ProductService productService,
        ReviewService reviewService,
        AIService aiService)
    {
        _orderService = orderService;
        _productService = productService;
        _reviewService = reviewService;
        _aiService = aiService;
    }

    [McpServerTool]
    [Description("Get order history and status for a customer by their CustomerID. Returns up to 10 most recent orders with status information.")]
    public async Task<string> GetCustomerOrders(int customerId)
    {
        return await _orderService.GetCustomerOrderStatusAsync(customerId);
    }

    [McpServerTool]
    [Description("Get detailed information about a specific order including items, pricing, and shipping status. Optional: Validates order belongs to customer.")]
    public async Task<string> GetOrderDetails(int orderId, int? customerId = null)
    {
        return await _orderService.GetOrderDetailsAsync(orderId, customerId);
    }

    [McpServerTool]
    [Description("Find products that are frequently purchased together with a specific product. Great for product recommendations.")]
    public async Task<string> FindComplementaryProducts(int productId, int limit = 5)
    {
        return await _orderService.FindComplementaryProductsAsync(productId, limit);
    }

    [McpServerTool]
    [Description("Search for products by name, category, or attributes. Returns matching products with details. Supports multiple languages: ar, en (default), es, fr, he, th, zh-cht, en-gb, en-ca, en-au, ja, ko, de.")]
    public async Task<string> SearchProducts(string searchTerm, string? cultureId = null, int? categoryId = null)
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

        return result.ToString();
    }

    [McpServerTool]
    [Description("Get detailed information about a specific product including specifications, pricing, and inventory.")]
    public async Task<string> GetProductDetails(int productId)
    {
        var products = await _productService.GetFinishedGoodsProductsAsync(new List<int> { productId });

        if (!products.Any())
        {
            return $"Product ID {productId} not found";
        }

        var product = products.First();
        var result = new System.Text.StringBuilder();

        result.AppendLine($"{product.Name}");
        result.AppendLine($"Product Number: {product.ProductNumber}");
        result.AppendLine($"Category: {product.ProductCategoryName} / {product.ProductSubcategoryName}");
        result.AppendLine($"Price: ${product.ListPrice:N2}");
        result.AppendLine($"Cost: ${product.StandardCost:N2}");

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

        return result.ToString();
    }

    [McpServerTool]
    [Description("Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like.")]
    public async Task<string> GetPersonalizedRecommendations(int customerId, int limit = 5)
    {
        return await _orderService.GetPersonalizedRecommendationsAsync(customerId, limit);
    }

    [McpServerTool]
    [Description("Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback.")]
    public async Task<string> AnalyzeProductReviews(int productId)
    {
        return await _reviewService.AnalyzeProductReviewsAsync(productId);
    }

    [McpServerTool]
    [Description("Check real-time inventory availability for a product across all warehouse locations. Returns stock levels, locations, and availability status.")]
    public async Task<string> CheckInventoryAvailability(int productId)
    {
        return await _productService.CheckInventoryAvailabilityAsync(productId);
    }
}
