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
    public async Task<string> GetCustomerOrders(int customerId, [McpHeader("Culture")] string? cultureId = null)
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
    public async Task<string> GetOrderDetails(int orderId, int? customerId = null, [McpHeader("Culture")] string? cultureId = null)
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
    public async Task<string> FindComplementaryProducts(int productId, int limit = 5, [McpHeader("Culture")] string? cultureId = null)
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
    [Description("Search for products by name, category, or attributes. Returns matching products with details. Supports multiple languages: ar, de, en (default), en-au, en-ca, en-gb, en-ie, en-nz, es, fr, he, id, it, ja, ko, nl, pt, ru, th, tr, vi, zh, zh-cht.")]
    public async Task<string> SearchProducts(string searchTerm, [McpHeader("Culture")] string? cultureId = null, int? categoryId = null)
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
    [Description("Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like. Requires an existing customer ID with purchase history. Supports multiple languages.")]
    public async Task<string> GetPersonalizedRecommendations(int? customerId = null, int limit = 5, [McpHeader("Culture")] string? cultureId = null)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetPersonalizedRecommendations");
        operation.Telemetry.Properties["customerId"] = customerId?.ToString() ?? "null";
        operation.Telemetry.Properties["limit"] = limit.ToString();
        operation.Telemetry.Properties["cultureId"] = cultureId ?? "en";

        if (!customerId.HasValue || customerId.Value <= 0)
            return "get_personalized_recommendations requires a valid existing customer ID (customerId > 0). This tool is only useful for customers who have already placed orders. For new customers or personas without an ID, use search_products or get_categories_with_products instead.";

        try
        {
            var result = await _orderService.GetPersonalizedRecommendationsAsync(customerId.Value, limit, cultureId ?? "en");
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetPersonalizedRecommendations" },
                { "customerId", customerId.Value.ToString() },
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
                { "customerId", customerId.Value.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback. Supports multiple languages.")]
    public async Task<string> AnalyzeProductReviews(int productId, [McpHeader("Culture")] string? cultureId = null)
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
    public async Task<string> CheckInventoryAvailability(int productId, [McpHeader("Culture")] string? cultureId = null)
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

    [McpServerTool]
    [Description("Get products with inventory and sales data to support promotion creation. Returns products ranked by their suitability for the given promotion type. For 'Clearance': high stock + low recent sales. For 'Volume Discount': popular items with high sales. Optionally filter by productCategoryId or productSubcategoryId.")]
    public async Task<string> GetProductsForPromotion(
        string promotionType,
        int? productCategoryId = null,
        int? productSubcategoryId = null,
        int topN = 20)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetProductsForPromotion");
        operation.Telemetry.Properties["promotionType"] = promotionType;
        operation.Telemetry.Properties["categoryId"] = productCategoryId?.ToString() ?? "all";
        operation.Telemetry.Properties["subcategoryId"] = productSubcategoryId?.ToString() ?? "all";
        operation.Telemetry.Properties["topN"] = topN.ToString();

        try
        {
            var result = await _productService.GetProductsWithPromotionDataAsync(
                promotionType, productCategoryId, productSubcategoryId, topN);

            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetProductsForPromotion" },
                { "promotionType", promotionType },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetProductsForPromotion" },
                { "promotionType", promotionType }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get the full AdventureWorks product catalogue organized by category and subcategory, showing in-stock products with prices and stock levels. Use this first when planning an order to understand what is available to buy.")]
    public async Task<string> GetCategoriesWithProducts(int maxProductsPerSubcategory = 10)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetCategoriesWithProducts");
        operation.Telemetry.Properties["maxProductsPerSubcategory"] = maxProductsPerSubcategory.ToString();

        try
        {
            var result = await _productService.GetCategoriesWithProductsAsync(maxProductsPerSubcategory);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetCategoriesWithProducts" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetCategoriesWithProducts" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get all currently active promotions with eligible products and discount details. Use this when planning orders so you can apply available discounts to make the order more realistic.")]
    public async Task<string> GetActivePromotions()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetActivePromotions");

        try
        {
            var result = await _productService.GetActivePromotionsAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetActivePromotions" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetActivePromotions" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Find the most recently registered customers who have NEVER placed any order. Returns CustomerID, full name, email, and location. Use this for conversion analysis, outreach campaigns, or when asked about new customers without purchases.")]
    public async Task<string> GetRecentCustomersWithoutOrders(int limit = 10)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetRecentCustomersWithoutOrders");
        operation.Telemetry.Properties["limit"] = limit.ToString();

        try
        {
            var result = await _orderService.GetRecentCustomersWithoutOrdersAsync(limit);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetRecentCustomersWithoutOrders" },
                { "limit", limit.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetRecentCustomersWithoutOrders" },
                { "limit", limit.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Search existing AdventureWorks customers by name (partial match). Returns CustomerID, name, email, location, and order history summary. Use this to find a real customer to associate with a generated order.")]
    public async Task<string> SearchCustomers(string? nameFilter = null, int limit = 20)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_SearchCustomers");
        operation.Telemetry.Properties["nameFilter"] = nameFilter ?? "(none)";
        operation.Telemetry.Properties["limit"] = limit.ToString();

        try
        {
            var result = await _orderService.SearchCustomersAsync(nameFilter, limit);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "SearchCustomers" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "SearchCustomers" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Get the top-selling products ranked by total revenue. Use this for admin analytics questions about best sellers, most popular products, top revenue items, or product sales performance. Optionally filter to a recent time window using dateRangeMonths (e.g. 12 for the last year, 3 for the last quarter). Leave dateRangeMonths as 0 or omit it for all-time rankings.")]
    public async Task<string> GetTopSellingProducts(int topN = 10, int dateRangeMonths = 0)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetTopSellingProducts");
        operation.Telemetry.Properties["topN"] = topN.ToString();
        operation.Telemetry.Properties["dateRangeMonths"] = dateRangeMonths.ToString();

        try
        {
            var result = await _productService.GetTopSellingProductsAsync(
                topN,
                dateRangeMonths > 0 ? dateRangeMonths : (int?)null);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetTopSellingProducts" },
                { "topN", topN.ToString() },
                { "dateRangeMonths", dateRangeMonths.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                { "tool", "GetTopSellingProducts" },
                { "topN", topN.ToString() }
            });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Return high-level business KPIs — total customers, total orders, total revenue, orders and revenue broken down by status (In Process, Approved, Backordered, Rejected, Shipped, Cancelled), and top 5 product categories by revenue. Use this when asked for a dashboard, business overview, summary stats, or 'show me the numbers'.")]
    public async Task<string> GetBusinessStats()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetBusinessStats");
        try
        {
            var result = await _orderService.GetBusinessStatsAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetBusinessStats" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetBusinessStats" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Return the top N customers ranked by their lifetime total spend. Use this when asked 'who are the best/top customers', 'highest-value customers', or 'biggest spenders'. Default is top 10; pass topN to change.")]
    public async Task<string> GetTopCustomers(int topN = 10)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetTopCustomers");
        operation.Telemetry.Properties["topN"] = topN.ToString();
        try
        {
            var result = await _orderService.GetTopCustomersAsync(topN);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetTopCustomers" },
                { "topN", topN.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetTopCustomers" }, { "topN", topN.ToString() } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Return orders filtered by a plain-English status name. Accepted values for statusFilter: 'pending' (same as 'in process'), 'approved', 'backordered', 'rejected', 'shipped', 'cancelled'. Leave statusFilter empty or null to return all orders. Use this when asked to 'show pending orders', 'list shipped orders', 'find cancelled orders', etc.")]
    public async Task<string> GetOrdersByStatus(string? statusFilter = null, int limit = 50)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetOrdersByStatus");
        operation.Telemetry.Properties["statusFilter"] = statusFilter ?? "all";
        operation.Telemetry.Properties["limit"] = limit.ToString();
        try
        {
            var result = await _orderService.GetOrdersByStatusAsync(statusFilter, limit);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetOrdersByStatus" },
                { "statusFilter", statusFilter ?? "all" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetOrdersByStatus" }, { "statusFilter", statusFilter ?? "all" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Generate a sales report grouped by order status. Returns order count, total revenue, average order value, and date range for each status (In Process, Approved, Backordered, Rejected, Shipped, Cancelled) plus a grand total. Use this when asked for a 'sales report by status', 'order breakdown', or 'revenue by status'.")]
    public async Task<string> GetSalesReportByStatus()
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetSalesReportByStatus");
        try
        {
            var result = await _orderService.GetSalesReportByStatusAsync();
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetSalesReportByStatus" },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetSalesReportByStatus" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Admin tool: Get a comprehensive performance summary for a specific product by ProductID. Returns pricing, gross margin, total units sold, total revenue, sales rank among all products, current stock level, and customer review rating. Use this when asked to 'analyze product X', 'how is product X performing', or 'product X success'.")]
    public async Task<string> GetProductPerformanceSummary(int productId)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GetProductPerformanceSummary");
        operation.Telemetry.Properties["productId"] = productId.ToString();
        try
        {
            var result = await _orderService.GetProductPerformanceSummaryAsync(productId);
            operation.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GetProductPerformanceSummary" },
                { "productId", productId.ToString() },
                { "resultLength", result.Length.ToString() }
            });
            return result;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GetProductPerformanceSummary" }, { "productId", productId.ToString() } });
            throw;
        }
    }
}
