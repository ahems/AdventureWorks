using System.ComponentModel;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// AdventureWorks MCP Tools - Provides AI agents with tools to query AdventureWorks data
/// </summary>
public class AdventureWorksMcpTools
{
    private readonly OrderService _orderService;
    private readonly ProductService _productService;
    private readonly ReviewService _reviewService;

    public AdventureWorksMcpTools(OrderService orderService, ProductService productService, ReviewService reviewService)
    {
        _orderService = orderService;
        _productService = productService;
        _reviewService = reviewService;
    }

    /// <summary>
    /// Get all available MCP tool definitions
    /// </summary>
    public McpToolListResponse GetToolDefinitions()
    {
        return new McpToolListResponse
        {
            Tools = new List<McpToolDefinition>
            {
                new McpToolDefinition
                {
                    Name = "get_customer_orders",
                    Description = "Get order history and status for a customer by their CustomerID. Returns up to 10 most recent orders with status information.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "customerId", new McpProperty { Type = "integer", Description = "Customer ID to look up orders" } }
                        },
                        Required = new List<string> { "customerId" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "get_order_details",
                    Description = "Get detailed information about a specific order including items, pricing, and shipping status. Optional: Validates order belongs to customer.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "orderId", new McpProperty { Type = "integer", Description = "Order ID to retrieve details for" } },
                            { "customerId", new McpProperty { Type = "integer", Description = "Optional: Customer ID to validate order access" } }
                        },
                        Required = new List<string> { "orderId" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "find_complementary_products",
                    Description = "Find products that are frequently purchased together with a specific product. Great for product recommendations.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "productId", new McpProperty { Type = "integer", Description = "Product ID to find complementary products for" } },
                            { "limit", new McpProperty { Type = "integer", Description = "Maximum number of recommendations to return (default: 5)" } }
                        },
                        Required = new List<string> { "productId" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "search_products",
                    Description = "Search for products by name, category, or attributes. Returns matching products with details.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "searchTerm", new McpProperty { Type = "string", Description = "Text to search for in product names and descriptions" } },
                            { "categoryId", new McpProperty { Type = "integer", Description = "Optional: Filter by product category ID" } }
                        },
                        Required = new List<string> { "searchTerm" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "get_product_details",
                    Description = "Get detailed information about a specific product including specifications, pricing, and inventory.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "productId", new McpProperty { Type = "integer", Description = "Product ID to retrieve details for" } }
                        },
                        Required = new List<string> { "productId" }
                    }                },
                new McpToolDefinition
                {
                    Name = "get_personalized_recommendations",
                    Description = "Get personalized product recommendations for a customer based on their purchase history, preferences, and buying patterns. Returns products the customer might like.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "customerId", new McpProperty { Type = "integer", Description = "Customer ID to generate recommendations for" } },
                            { "limit", new McpProperty { Type = "integer", Description = "Maximum number of recommendations to return (default: 5)" } }
                        },
                        Required = new List<string> { "customerId" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "analyze_product_reviews",
                    Description = "Analyze and summarize customer reviews for a product. Returns average rating, review count, sentiment analysis, and common themes from customer feedback.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "productId", new McpProperty { Type = "integer", Description = "Product ID to analyze reviews for" } }
                        },
                        Required = new List<string> { "productId" }
                    }
                },
                new McpToolDefinition
                {
                    Name = "check_inventory_availability",
                    Description = "Check real-time inventory availability for a product across all warehouse locations. Returns stock levels, locations, and availability status.",
                    InputSchema = new McpInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            { "productId", new McpProperty { Type = "integer", Description = "Product ID to check inventory for" } }
                        },
                        Required = new List<string> { "productId" }
                    }                }
            }
        };
    }

    /// <summary>
    /// Execute a specific MCP tool by name
    /// </summary>
    public async Task<McpToolResponse> ExecuteToolAsync(McpToolRequest request)
    {
        try
        {
            string result = request.Name switch
            {
                "get_customer_orders" => await ExecuteGetCustomerOrdersAsync(request.Arguments),
                "get_order_details" => await ExecuteGetOrderDetailsAsync(request.Arguments),
                "find_complementary_products" => await ExecuteFindComplementaryProductsAsync(request.Arguments),
                "search_products" => await ExecuteSearchProductsAsync(request.Arguments),
                "get_product_details" => await ExecuteGetProductDetailsAsync(request.Arguments),
                "get_personalized_recommendations" => await ExecuteGetPersonalizedRecommendationsAsync(request.Arguments),
                "analyze_product_reviews" => await ExecuteAnalyzeProductReviewsAsync(request.Arguments),
                "check_inventory_availability" => await ExecuteCheckInventoryAvailabilityAsync(request.Arguments),
                _ => $"Unknown tool: {request.Name}"
            };

            return new McpToolResponse
            {
                Content = new List<McpContent>
                {
                    new McpContent { Type = "text", Text = result }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            return new McpToolResponse
            {
                Content = new List<McpContent>
                {
                    new McpContent { Type = "text", Text = $"Error executing tool: {ex.Message}" }
                },
                IsError = true
            };
        }
    }

    private async Task<string> ExecuteGetCustomerOrdersAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("customerId"))
        {
            return "Error: customerId parameter is required";
        }

        if (!int.TryParse(arguments["customerId"].ToString(), out int customerId))
        {
            return "Error: customerId must be a valid integer";
        }

        return await _orderService.GetCustomerOrderStatusAsync(customerId);
    }

    private async Task<string> ExecuteGetOrderDetailsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("orderId"))
        {
            return "Error: orderId parameter is required";
        }

        if (!int.TryParse(arguments["orderId"].ToString(), out int orderId))
        {
            return "Error: orderId must be a valid integer";
        }

        // Get optional customerId for access validation
        int? customerId = null;
        if (arguments.ContainsKey("customerId") && arguments["customerId"] != null)
        {
            if (int.TryParse(arguments["customerId"].ToString(), out int parsedCustomerId))
            {
                customerId = parsedCustomerId;
            }
        }

        return await _orderService.GetOrderDetailsAsync(orderId, customerId);
    }

    private async Task<string> ExecuteFindComplementaryProductsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("productId"))
        {
            return "Error: productId parameter is required";
        }

        if (!int.TryParse(arguments["productId"].ToString(), out int productId))
        {
            return "Error: productId must be a valid integer";
        }

        int limit = 5; // default
        if (arguments.ContainsKey("limit") && int.TryParse(arguments["limit"].ToString(), out int parsedLimit))
        {
            limit = parsedLimit;
        }

        return await _orderService.FindComplementaryProductsAsync(productId, limit);
    }

    private async Task<string> ExecuteSearchProductsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("searchTerm"))
        {
            return "Error: searchTerm parameter is required";
        }

        var searchTerm = arguments["searchTerm"].ToString() ?? string.Empty;

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

    private async Task<string> ExecuteGetProductDetailsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("productId"))
        {
            return "Error: productId parameter is required";
        }

        if (!int.TryParse(arguments["productId"].ToString(), out int productId))
        {
            return "Error: productId must be a valid integer";
        }

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

    private async Task<string> ExecuteGetPersonalizedRecommendationsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("customerId"))
        {
            return "Error: customerId parameter is required";
        }

        if (!int.TryParse(arguments["customerId"].ToString(), out int customerId))
        {
            return "Error: customerId must be a valid integer";
        }

        int limit = 5; // default
        if (arguments.ContainsKey("limit") && int.TryParse(arguments["limit"].ToString(), out int parsedLimit))
        {
            limit = parsedLimit;
        }

        return await _orderService.GetPersonalizedRecommendationsAsync(customerId, limit);
    }

    private async Task<string> ExecuteAnalyzeProductReviewsAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("productId"))
        {
            return "Error: productId parameter is required";
        }

        if (!int.TryParse(arguments["productId"].ToString(), out int productId))
        {
            return "Error: productId must be a valid integer";
        }

        return await _reviewService.AnalyzeProductReviewsAsync(productId);
    }

    private async Task<string> ExecuteCheckInventoryAvailabilityAsync(Dictionary<string, object>? arguments)
    {
        if (arguments == null || !arguments.ContainsKey("productId"))
        {
            return "Error: productId parameter is required";
        }

        if (!int.TryParse(arguments["productId"].ToString(), out int productId))
        {
            return "Error: productId must be a valid integer";
        }

        return await _productService.CheckInventoryAvailabilityAsync(productId);
    }
}
