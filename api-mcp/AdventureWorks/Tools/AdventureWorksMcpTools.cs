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
    [Description("Get order history and status for a customer by their CustomerID. Returns up to 10 most recent orders with status information. Supports multiple languages.")]
    public async Task<string> GetCustomerOrders(int customerId, [McpHeader("Culture")] string? cultureId = null)
    {

        return await _orderService.GetCustomerOrderStatusAsync(customerId, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Get detailed information about a specific order including items, pricing, and shipping status. Optional: Validates order belongs to customer. Supports multiple languages.")]
    public async Task<string> GetOrderDetails(int orderId, int? customerId = null, [McpHeader("Culture")] string? cultureId = null)
    {

        return await _orderService.GetOrderDetailsAsync(orderId, customerId, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Find products that are frequently purchased together with a specific product. Great for product recommendations. Supports multiple languages.")]
    public async Task<string> FindComplementaryProducts(int productId, int limit = 5, [McpHeader("Culture")] string? cultureId = null)
    {

        return await _orderService.FindComplementaryProductsAsync(productId, limit, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Search for products by name, category, or attributes. Returns matching products with details. Supports multiple languages: ar, de, en (default), en-au, en-ca, en-gb, en-ie, en-nz, es, fr, he, id, it, ja, ko, nl, pt, ru, th, tr, vi, zh, zh-cht.")]
    public async Task<string> SearchProducts(string searchTerm, [McpHeader("Culture")] string? cultureId = null, int? categoryId = null)
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
        return resultString;
    }

    [McpServerTool]
    [Description("Get detailed information about a specific product including specifications, pricing, and inventory.")]
    public async Task<string> GetProductDetails(int productId)
    {

        var products = await _productService.GetFinishedGoodsProductsAsync(new List<int> { productId });

        if (!products.Any())
        {
            var notFoundResult = $"Product ID {productId} not found";
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
        return resultString;
    }

    [McpServerTool]
    [Description("Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like. Requires an existing customer ID with purchase history. Supports multiple languages.")]
    public async Task<string> GetPersonalizedRecommendations(int? customerId = null, int limit = 5, [McpHeader("Culture")] string? cultureId = null)
    {

        if (!customerId.HasValue || customerId.Value <= 0)
            return "get_personalized_recommendations requires a valid existing customer ID (customerId > 0). This tool is only useful for customers who have already placed orders. For new customers or personas without an ID, use search_products or get_categories_with_products instead.";

        return await _orderService.GetPersonalizedRecommendationsAsync(customerId.Value, limit, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback. Supports multiple languages.")]
    public async Task<string> AnalyzeProductReviews(int productId, [McpHeader("Culture")] string? cultureId = null)
    {

        return await _reviewService.AnalyzeProductReviewsAsync(productId, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Check real-time inventory availability for a product in finished goods locations. Returns stock levels, finished goods storage locations, and availability status. Supports multiple languages.")]
    public async Task<string> CheckInventoryAvailability(int productId, [McpHeader("Culture")] string? cultureId = null)
    {

        return await _productService.CheckInventoryAvailabilityAsync(productId, cultureId ?? "en");
    }

    [McpServerTool]
    [Description("Get products with inventory and sales data to support promotion creation. Returns products ranked by their suitability for the given promotion type. For 'Clearance': high stock + low recent sales. For 'Volume Discount': popular items with high sales. Optionally filter by productCategoryId or productSubcategoryId.")]
    public async Task<string> GetProductsForPromotion(
        string promotionType,
        int? productCategoryId = null,
        int? productSubcategoryId = null,
        int topN = 20)
    {

        var result = await _productService.GetProductsWithPromotionDataAsync(
            promotionType, productCategoryId, productSubcategoryId, topN);

        return result;
    }

    [McpServerTool]
    [Description("Get the full AdventureWorks product catalogue organized by category and subcategory, showing in-stock products with prices and stock levels. Use this first when planning an order to understand what is available to buy.")]
    public async Task<string> GetCategoriesWithProducts(int maxProductsPerSubcategory = 10)
    {

        return await _productService.GetCategoriesWithProductsAsync(maxProductsPerSubcategory);
    }

    [McpServerTool]
    [Description("Get all currently active promotions with eligible products and discount details. Use this when planning orders so you can apply available discounts to make the order more realistic.")]
    public async Task<string> GetActivePromotions()
    {

        return await _productService.GetActivePromotionsAsync();
    }

    [McpServerTool]
    [Description("Admin tool: Find the most recently registered customers who have NEVER placed any order. Returns CustomerID, full name, email, and location. Use this for conversion analysis, outreach campaigns, or when asked about new customers without purchases.")]
    public async Task<string> GetRecentCustomersWithoutOrders(int limit = 10)
    {

        return await _orderService.GetRecentCustomersWithoutOrdersAsync(limit);
    }

    [McpServerTool]
    [Description("Search existing AdventureWorks customers by name (partial match). Returns CustomerID, name, email, location, and order history summary. Use this to find a real customer to associate with a generated order.")]
    public async Task<string> SearchCustomers(string? nameFilter = null, int limit = 20)
    {

        return await _orderService.SearchCustomersAsync(nameFilter, limit);
    }

    [McpServerTool]
    [Description("Get the top-selling products ranked by total revenue. Use this for admin analytics questions about best sellers, most popular products, top revenue items, or product sales performance. Optionally filter to a recent time window using dateRangeMonths (e.g. 12 for the last year, 3 for the last quarter). Leave dateRangeMonths as 0 or omit it for all-time rankings.")]
    public async Task<string> GetTopSellingProducts(int topN = 10, int dateRangeMonths = 0)
    {

        return await _productService.GetTopSellingProductsAsync(
            topN,
            dateRangeMonths > 0 ? dateRangeMonths : (int?)null);
    }

    [McpServerTool]
    [Description("Admin tool: Return high-level business KPIs — total customers, total orders, total revenue, orders and revenue broken down by status (In Process, Approved, Backordered, Rejected, Shipped, Cancelled), and top 5 product categories by revenue. Use this when asked for a dashboard, business overview, summary stats, or 'show me the numbers'.")]
    public async Task<string> GetBusinessStats()
    {
        return await _orderService.GetBusinessStatsAsync();
    }

    [McpServerTool]
    [Description("Admin tool: Return the top N customers ranked by their lifetime total spend. Use this when asked 'who are the best/top customers', 'highest-value customers', or 'biggest spenders'. Default is top 10; pass topN to change.")]
    public async Task<string> GetTopCustomers(int topN = 10)
    {
        return await _orderService.GetTopCustomersAsync(topN);
    }

    [McpServerTool]
    [Description("Admin tool: Return orders filtered by a plain-English status name. Accepted values for statusFilter: 'pending' (same as 'in process'), 'approved', 'backordered', 'rejected', 'shipped', 'cancelled'. Leave statusFilter empty or null to return all orders. Use this when asked to 'show pending orders', 'list shipped orders', 'find cancelled orders', etc.")]
    public async Task<string> GetOrdersByStatus(string? statusFilter = null, int limit = 50)
    {
        return await _orderService.GetOrdersByStatusAsync(statusFilter, limit);
    }

    [McpServerTool]
    [Description("Admin tool: Generate a sales report grouped by order status. Returns order count, total revenue, average order value, and date range for each status (In Process, Approved, Backordered, Rejected, Shipped, Cancelled) plus a grand total. Use this when asked for a 'sales report by status', 'order breakdown', or 'revenue by status'.")]
    public async Task<string> GetSalesReportByStatus()
    {
        return await _orderService.GetSalesReportByStatusAsync();
    }

    [McpServerTool]
    [Description("Admin tool: Get a comprehensive performance summary for a specific product by ProductID. Returns pricing, gross margin, total units sold, total revenue, sales rank among all products, current stock level, and customer review rating. Use this when asked to 'analyze product X', 'how is product X performing', or 'product X success'.")]
    public async Task<string> GetProductPerformanceSummary(int productId)
    {
        return await _orderService.GetProductPerformanceSummaryAsync(productId);
    }
}
