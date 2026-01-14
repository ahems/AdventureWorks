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

    public AdventureWorksMcpTools(
        OrderService orderService,
        ProductService productService,
        ReviewService reviewService)
    {
        _orderService = orderService;
        _productService = productService;
        _reviewService = reviewService;
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
    [Description("Search for products by name, category, or attributes. Returns matching products with details.")]
    public async Task<string> SearchProducts(string searchTerm, int? categoryId = null)
    {
        // Get all products and filter by search term
        var products = await _productService.GetFinishedGoodsProductsAsync();
        var filtered = products.Where(p =>
            p.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase) ||
            (p.Description?.Contains(searchTerm, StringComparison.OrdinalIgnoreCase) ?? false) ||
            (p.ProductCategoryName?.Contains(searchTerm, StringComparison.OrdinalIgnoreCase) ?? false)
        ).Take(10).ToList();

        if (!filtered.Any())
        {
            return $"No products found matching '{searchTerm}'";
        }

        var result = new System.Text.StringBuilder();
        result.AppendLine($"Found {filtered.Count} products matching '{searchTerm}':");
        result.AppendLine();

        foreach (var product in filtered)
        {
            result.AppendLine($"{product.Name} (ID: {product.ProductID})");
            result.AppendLine($"  Category: {product.ProductCategoryName}");
            result.AppendLine($"  Price: ${product.ListPrice:N2}");
            if (!string.IsNullOrEmpty(product.Description))
            {
                var shortDesc = product.Description.Length > 100
                    ? product.Description.Substring(0, 97) + "..."
                    : product.Description;
                result.AppendLine($"  Description: {shortDesc}");
            }
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
