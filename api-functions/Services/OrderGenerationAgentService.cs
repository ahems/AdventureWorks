using System.Text.Json;
using System.Text.RegularExpressions;
using Azure.Identity;
using Azure.AI.OpenAI;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

namespace api_functions.Services;

/// <summary>
/// Orchestrates an AI agent that reasons over live AdventureWorks data via MCP tools
/// to design a realistic purchase order for a given customer persona, then writes it
/// to the database using OrderGenerationService.
/// </summary>
public class OrderGenerationAgentService
{
    private readonly ILogger<OrderGenerationAgentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly TelemetryClient _telemetryClient;
    private readonly OrderGenerationService _orderGenService;
    private readonly ReceiptService _receiptService;
    private readonly PdfReceiptGenerator _pdfGenerator;
    private readonly string _endpoint;
    private readonly string _modelDeployment;
    private readonly string _mcpServerUrl;

    public OrderGenerationAgentService(
        ILogger<OrderGenerationAgentService> logger,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory,
        TelemetryClient telemetryClient,
        OrderGenerationService orderGenService,
        ReceiptService receiptService,
        PdfReceiptGenerator pdfGenerator)
    {
        _logger = logger;
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
        _telemetryClient = telemetryClient;
        _orderGenService = orderGenService;
        _receiptService = receiptService;
        _pdfGenerator = pdfGenerator;

        _endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");
        _modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

        var mcpServiceUrl = configuration["MCP_SERVICE_URL"];
        _mcpServerUrl = !string.IsNullOrEmpty(mcpServiceUrl)
            ? mcpServiceUrl.TrimEnd('/')
            : "http://localhost:5000/mcp";
    }

    /// <summary>
    /// Generate one realistic order for the given persona.
    /// Returns a structured result with step-by-step log entries and the created order ID.
    /// </summary>
    public async Task<OrderGenerationResult> GenerateOrderAsync(
        string personaType,
        string? customPersona,
        int? seedCustomerId = null,
        Action<string, string>? onLog = null)
    {
        var result = new OrderGenerationResult();
        var startTime = DateTimeOffset.UtcNow;

        void Log(string msg, string type = "info")
        {
            result.Log.Add(new OrderGenLogEntry { Message = msg, Type = type });
            onLog?.Invoke(msg, type);
            _logger.LogInformation("[OrderGen] {Message}", msg);
        }

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("OrderGeneration.Generate");
        operation.Telemetry.Properties["PersonaType"] = personaType;

        try
        {
            Log("Connecting to MCP server and loading tools...", "info");

            var mcpClient = await McpClient.CreateAsync(
                new HttpClientTransport(new()
                {
                    Name = "AdventureWorks MCP",
                    Endpoint = new Uri(_mcpServerUrl)
                })
            );

            var mcpTools = await mcpClient.ListToolsAsync();
            Log($"Loaded {mcpTools.Count} MCP tools", "dim");

            var credential = new DefaultAzureCredential();
            var chatClient = new AzureOpenAIClient(new Uri(_endpoint), credential)
                .GetChatClient(_modelDeployment)
                .AsIChatClient();

            // ── Resolve seed customer for "existing-customer" persona ─────────
            CustomerProfile? seedProfile = null;
            if (personaType == "existing-customer")
            {
                int resolvedCustomerId;
                if (seedCustomerId.HasValue && seedCustomerId.Value > 0)
                {
                    resolvedCustomerId = seedCustomerId.Value;
                }
                else
                {
                    Log("Picking a random existing customer...", "dim");
                    var ids = await _orderGenService.GetCustomerIdsWithOrdersAsync(200);
                    if (ids.Count == 0)
                        throw new InvalidOperationException("No customers with orders found in the database");
                    resolvedCustomerId = ids[Random.Shared.Next(ids.Count)];
                }

                Log($"Loading profile for CustomerID={resolvedCustomerId}...", "dim");
                seedProfile = await _orderGenService.GetCustomerProfileAsync(resolvedCustomerId);
                if (seedProfile == null)
                    throw new InvalidOperationException($"Customer {resolvedCustomerId} not found");

                Log($"Loaded profile: {seedProfile.FirstName} {seedProfile.LastName} — {seedProfile.OrderCount} orders, ${seedProfile.TotalSpend:N2} total spend", "info");
            }

            var personaDescription = seedProfile != null
                ? BuildExistingCustomerPersona(seedProfile)
                : BuildPersonaDescription(personaType, customPersona);

            Log($"Planning order for persona: {personaDescription}", "info");

            var agent = new ChatClientAgent(
                chatClient,
                instructions: SystemPrompt,
                name: "AdventureWorks Order Planner",
                tools: mcpTools.Cast<Microsoft.Extensions.AI.AITool>().ToList()
            );

            var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

            string userMessage;
            if (seedProfile != null)
            {
                // For existing-customer persona: instruct AI to use this specific customer
                var recentProducts = seedProfile.RecentProducts.Any()
                    ? string.Join(", ", seedProfile.RecentProducts.Take(10))
                    : "no recent orders";
                userMessage = $@"You are generating a realistic purchase order for a SPECIFIC existing AdventureWorks customer.

Customer Profile:
  Name: {seedProfile.FirstName} {seedProfile.LastName}
  CustomerID: {seedProfile.CustomerID}
  Email: {seedProfile.Email ?? "n/a"}
  Total Orders: {seedProfile.OrderCount}
  Total Spend: ${seedProfile.TotalSpend:N2}
  Recent Products Purchased: {recentProducts}

Today's Date: {today}

Your task: Determine what kind of cyclist/shopper this person is based on their purchase history and profile data.
Then simulate creating a new order that this specific person would realistically place today.

Follow these steps IN ORDER using the MCP tools:

1. Call GetCategoriesWithProducts to see what products are currently available (in-stock only).
2. Call GetActivePromotions to find current discounts that might appeal to this customer.
3. For each product you are considering ordering, call CheckInventoryAvailability to confirm stock > 0.
4. For products with reviews, call AnalyzeProductReviews to check sentiment — skip products with predominantly negative reviews.
5. Design a realistic shopping basket: typically 1-5 items that make sense for this customer's established buying patterns. Consider their spend history (high spender vs budget), the categories they've bought in before, and active promotions.

IMPORTANT: You MUST use this specific customer — do NOT search for a different customer.

Return ONLY a valid JSON object (no markdown, no preamble):
{{
  ""personaSummary"": ""One sentence describing the customer's profile and their shopping intent today"",
  ""existingCustomerId"": {seedProfile.CustomerID},
  ""newCustomer"": null,
  ""orderItems"": [
    {{
      ""productId"": 707,
      ""productName"": ""Sport-100 Helmet, Red"",
      ""quantity"": 1,
      ""unitPrice"": 34.99,
      ""specialOfferID"": 0,
      ""reason"": ""Replacing worn helmet based on prior helmet purchases""
    }}
  ],
  ""appliedPromotionIds"": [],
  ""aiReasoning"": ""Explanation of product choices and how they fit this customer's profile""
}}

Rules:
- existingCustomerId: MUST be {seedProfile.CustomerID} — do not change this
- newCustomer: MUST be null — we are using the existing customer
- specialOfferID: set to the SpecialOfferID if a promotion applies, otherwise 0
- quantity: realistic (1-3 per item; bikes qty 1; accessories 1-2)
- Only include products that have stock > 0
- Order value should be consistent with this customer's historical spend level";
            }
            else
            {
                userMessage = $@"You are generating a realistic purchase order for an AdventureWorks customer.

Customer Persona: {personaDescription}
Today's Date: {today}

Follow these steps IN ORDER using the MCP tools:

1. Call GetCategoriesWithProducts to see what products are available (in-stock only).
2. Call GetActivePromotions to find current discounts that might appeal to this customer.
3. Call SearchCustomers (no filter, limit=30) to find a suitable EXISTING customer that fits the persona. Prefer customers with some order history. If none match well, you will create a new one.
4. For each product you are considering ordering, call CheckInventoryAvailability to confirm stock > 0.
5. For products with reviews, call AnalyzeProductReviews to check sentiment — skip products with predominantly negative reviews.
6. Design a realistic shopping basket: typically 1-5 items that make sense for this persona. Consider price range, category mix, and active promotions.

Return ONLY a valid JSON object (no markdown, no preamble):
{{
  ""personaSummary"": ""One sentence describing the customer and their shopping intent"",
  ""existingCustomerId"": 12345,
  ""newCustomer"": null,
  ""orderItems"": [
    {{
      ""productId"": 707,
      ""productName"": ""Sport-100 Helmet, Red"",
      ""quantity"": 1,
      ""unitPrice"": 34.99,
      ""specialOfferID"": 0,
      ""reason"": ""Newbie needs a safety helmet""
    }}
  ],
  ""appliedPromotionIds"": [],
  ""aiReasoning"": ""Explanation of product choices and persona fit""
}}

Rules:
- existingCustomerId: set to a real CustomerID found via SearchCustomers, OR null if creating new
- newCustomer: only set if existingCustomerId is null — provide: firstName, lastName, email, addressLine1, city, stateCode, postalCode
- specialOfferID: set to the SpecialOfferID if a promotion applies, otherwise 0
- quantity: realistic (1-3 per item; bikes qty 1; accessories 1-2)
- Only include products that have stock > 0
- Total order value should feel realistic for the persona (budget shopper vs enthusiast)";
            }

            Log("AI agent reasoning over catalogue, promotions, and customers...", "dim");

            var messages = new List<Microsoft.Extensions.AI.ChatMessage>
            {
                new(ChatRole.User, userMessage)
            };

            var responseBuilder = new System.Text.StringBuilder();
            await foreach (var update in agent.RunStreamingAsync(messages))
            {
                if (!string.IsNullOrEmpty(update.Text))
                    responseBuilder.Append(update.Text);
            }

            var rawResponse = responseBuilder.ToString();
            _logger.LogInformation("AI order plan raw response length: {Length}", rawResponse.Length);

            Log("AI finished reasoning — parsing order plan...", "dim");
            var plan = ParseOrderPlan(rawResponse);

            Log($"AI reasoning: {plan.AiReasoning}", "dim");
            Log($"Persona: {plan.PersonaSummary}", "info");

            // ── Resolve customer ─────────────────────────────────────────────
            int customerId;
            // If we used a seed customer (existing-customer persona), always honour it
            if (seedProfile != null)
            {
                customerId = seedProfile.CustomerID;
                result.CustomerName = $"{seedProfile.FirstName} {seedProfile.LastName}";
                result.CustomerEmail = seedProfile.Email;
                Log($"Using seed customer: {result.CustomerName} (ID={customerId})", "success");
            }
            else if (plan.ExistingCustomerId.HasValue && plan.ExistingCustomerId.Value > 0)
            {
                var existing = await _orderGenService.GetCustomerAsync(plan.ExistingCustomerId.Value);
                if (existing != null)
                {
                    customerId = existing.CustomerID;
                    Log($"Using existing customer: {existing.FirstName} {existing.LastName} (ID={customerId})", "success");
                    result.CustomerName = $"{existing.FirstName} {existing.LastName}";
                    result.CustomerEmail = existing.Email;
                }
                else
                {
                    Log($"Customer ID {plan.ExistingCustomerId.Value} not found — creating new customer", "info");
                    customerId = await CreateNewCustomer(plan, result, Log);
                }
            }
            else if (plan.NewCustomer != null)
            {
                customerId = await CreateNewCustomer(plan, result, Log);
            }
            else
            {
                throw new InvalidOperationException("AI plan did not specify a customer");
            }

            // ── Validate items & check stock ─────────────────────────────────
            Log("Validating items and checking live inventory...", "info");
            var validItems = new List<OrderLineItem>();

            foreach (var item in plan.OrderItems)
            {
                var stock = await _orderGenService.GetProductStockAsync(item.ProductId);
                if (stock < item.Quantity)
                {
                    Log($"  Skipping ProductID={item.ProductId} ({item.ProductName}): stock={stock} < qty={item.Quantity}", "dim");
                    continue;
                }

                var price = item.UnitPrice > 0 ? item.UnitPrice
                    : await _orderGenService.GetProductPriceAsync(item.ProductId);

                var offerId = item.SpecialOfferID > 0 ? item.SpecialOfferID
                    : await _orderGenService.GetBestSpecialOfferAsync(item.ProductId);

                validItems.Add(new OrderLineItem
                {
                    ProductId = item.ProductId,
                    Quantity = (short)Math.Max(1, item.Quantity),
                    UnitPrice = price,
                    SpecialOfferID = offerId
                });

                var offerNote = offerId > 1 ? $" (promotion ID={offerId})" : "";
                Log($"  ✓ {item.ProductName} × {item.Quantity} @ ${price:N2}{offerNote} — stock: {stock}", "success");
            }

            if (!validItems.Any())
                throw new InvalidOperationException("All planned items are out of stock or unavailable");

            // ── Create the order ─────────────────────────────────────────────
            Log("Creating order in database...", "info");
            var salesOrderId = await _orderGenService.CreateOrderAsync(new CreateOrderRequest
            {
                CustomerId = customerId,
                Items = validItems
            });

            Log($"Order created: SalesOrderID={salesOrderId}", "success");
            result.SalesOrderId = salesOrderId;

            // ── Generate receipt ─────────────────────────────────────────────
            Log("Generating PDF receipt...", "info");
            var receiptData = await _receiptService.GetReceiptDataBySalesOrderIDAsync(salesOrderId);
            if (receiptData != null)
            {
                result.ReceiptPdfBase64 = await _pdfGenerator.GenerateReceiptPdfBase64Async(receiptData);
                Log("Receipt generated successfully", "success");
            }
            else
            {
                Log("Receipt data not found — skipping PDF generation", "dim");
            }

            var duration = DateTimeOffset.UtcNow - startTime;
            result.Success = true;
            result.TotalDue = receiptData?.TotalDue ?? 0;
            operation.Telemetry.Success = true;

            _telemetryClient.TrackEvent("OrderGeneration.Success", new Dictionary<string, string>
            {
                ["PersonaType"] = personaType,
                ["CustomerId"] = customerId.ToString(),
                ["SalesOrderId"] = salesOrderId.ToString(),
                ["ItemCount"] = validItems.Count.ToString(),
                ["DurationMs"] = duration.TotalMilliseconds.ToString("F0")
            });

            Log($"Done! Order #{salesOrderId} created for {result.CustomerName} — Total: ${result.TotalDue:N2}", "success");

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Order generation failed for persona={Persona}", personaType);
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "OrderGeneration.Generate",
                ["PersonaType"] = personaType
            });

            Log($"Error: {ex.Message}", "error");
            result.ErrorMessage = ex.Message;
            return result;
        }
    }

    private async Task<int> CreateNewCustomer(
        OrderPlan plan,
        OrderGenerationResult result,
        Action<string, string> log)
    {
        var nc = plan.NewCustomer!;
        log($"Creating new customer: {nc.FirstName} {nc.LastName} ({nc.Email})", "info");

        var customerId = await _orderGenService.CreateCustomerAsync(new NewCustomerRequest
        {
            FirstName = nc.FirstName,
            LastName = nc.LastName,
            Email = nc.Email,
            AddressLine1 = nc.AddressLine1 ?? "1 Main St",
            City = nc.City ?? "Seattle",
            StateCode = nc.StateCode,
            PostalCode = nc.PostalCode ?? "98101"
        });

        result.CustomerName = $"{nc.FirstName} {nc.LastName}";
        result.CustomerEmail = nc.Email;
        result.NewCustomerCreated = true;
        log($"New customer created with CustomerID={customerId}", "success");
        return customerId;
    }

    private static string BuildPersonaDescription(string personaType, string? customPersona)
    {
        if (!string.IsNullOrEmpty(customPersona)) return customPersona;

        return personaType switch
        {
            "newbie-male" => "A male newcomer to cycling — never bought from AdventureWorks before. Wants to get started with their first bike plus essential gear (helmet, shorts, a water bottle). Mid-range budget.",
            "newbie-female" => "A female newcomer interested in getting into cycling. Looking for an entry-level bike, women's clothing and some accessories. Moderate budget.",
            "experienced-male" => "An experienced male cyclist and existing AdventureWorks customer with an order history. Looking to upgrade or replace worn components — perhaps a new helmet, tyres, or a higher-end jersey.",
            "experienced-female" => "An experienced female cyclist who already owns a bike and core gear. Looking for smaller refreshes: a new water bottle, a replacement cap, gloves, or a new saddle.",
            "family-shopper" => "A parent shopping for the whole family — multiple bikes (adults and kids sizes), helmets for everyone, and some shared accessories like a pump and lock.",
            "commuter" => "An urban commuter who uses their bike daily. Interested in durable, practical items: fenders, lights, a lock, commuter clothing, and perhaps a replacement chain or tyres.",
            "mountain-enthusiast" => "A passionate mountain biker looking for high-performance mountain bikes, protective gear (full-face helmet, knee pads), and trail accessories.",
            _ => $"A generic AdventureWorks customer interested in: {personaType}"
        };
    }

    private static string BuildExistingCustomerPersona(CustomerProfile profile)
    {
        var recentProducts = profile.RecentProducts.Any()
            ? string.Join(", ", profile.RecentProducts.Take(5))
            : "no prior purchases";
        return $"Existing customer {profile.FirstName} {profile.LastName} with {profile.OrderCount} previous orders " +
               $"totalling ${profile.TotalSpend:N2}. Recent purchases include: {recentProducts}.";
    }

    private static OrderPlan ParseOrderPlan(string rawResponse)
    {
        var cleaned = Regex.Replace(rawResponse, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
        cleaned = Regex.Replace(cleaned, @"```\s*$", "", RegexOptions.Multiline).Trim();

        var start = cleaned.IndexOf('{');
        var end = cleaned.LastIndexOf('}');
        if (start >= 0 && end > start)
            cleaned = cleaned.Substring(start, end - start + 1);

        return JsonSerializer.Deserialize<OrderPlan>(cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("AI returned unparseable JSON for order plan");
    }

    private const string SystemPrompt = @"You are an expert retail order planner for AdventureWorks, an outdoor sports equipment company.
Your job is to simulate realistic customer orders by researching available products, current promotions, and existing customers using the MCP tools.

Important rules:
- Always call GetCategoriesWithProducts FIRST to know what is available.
- Always call GetActivePromotions to factor in current discounts.
- Always call SearchCustomers to find a real existing customer if one fits the persona.
- Always call CheckInventoryAvailability for each product you are seriously considering.
- Prefer products with good review sentiment (call AnalyzeProductReviews when unsure).
- Never include out-of-stock products in the order.
- Return ONLY valid JSON — no preamble, no explanation outside the JSON object.";
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

public class OrderGenerationResult
{
    public bool Success { get; set; }
    public int SalesOrderId { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerEmail { get; set; }
    public bool NewCustomerCreated { get; set; }
    public decimal TotalDue { get; set; }
    public string? ReceiptPdfBase64 { get; set; }
    public string? ErrorMessage { get; set; }
    public List<OrderGenLogEntry> Log { get; set; } = new();
}

public class OrderGenLogEntry
{
    public string Message { get; set; } = string.Empty;
    public string Type { get; set; } = "info"; // info | success | error | dim
}

// AI-generated order plan DTO
public class OrderPlan
{
    public string PersonaSummary { get; set; } = string.Empty;
    public int? ExistingCustomerId { get; set; }
    public NewCustomerPlan? NewCustomer { get; set; }
    public List<PlannedOrderItem> OrderItems { get; set; } = new();
    public List<int> AppliedPromotionIds { get; set; } = new();
    public string AiReasoning { get; set; } = string.Empty;
}

public class NewCustomerPlan
{
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City { get; set; }
    public string? StateCode { get; set; }
    public string? PostalCode { get; set; }
}

public class PlannedOrderItem
{
    public int ProductId { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public int Quantity { get; set; } = 1;
    public decimal UnitPrice { get; set; }
    public int SpecialOfferID { get; set; }
    public string Reason { get; set; } = string.Empty;
}
