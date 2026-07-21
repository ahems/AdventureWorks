using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;

namespace api_functions.Services;

/// <summary>
/// Orchestrates an Azure AI Foundry Agent that reasons over live AdventureWorks data
/// via MCP tool servers to design a realistic purchase order for a given customer
/// persona, then writes it to the database using OrderGenerationService.
///
/// Foundry features used:
///   - structured_inputs    → persona and customer context resolved via Handlebars templates
///                            in the agent instructions; the user message is a short constant
///   - x-memory-user-id     → scopes memory per persona type (or per customer for existing-customer),
///                            so successive runs produce varied orders rather than repeating choices
///   - previousResponseId   → enables admin refinement turns (e.g. 'adjust the order for a higher budget')
///                            by continuing a stored Foundry conversation
///   - tool_choice: required → ensures the agent always calls MCP tools; prevents hallucinated
///                             catalog data from creating bogus orders in the database
/// </summary>
public class OrderGenerationAgentService
{
    private const string CustomerModeExisting = "existing";
    private const string CustomerModeNew = "new";
    private const string CustomerModeStore = "store";

    private readonly ILogger<OrderGenerationAgentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly TelemetryClient _telemetryClient;
    private readonly OrderGenerationService _orderGenService;
    private readonly ReceiptService _receiptService;
    private readonly PdfReceiptGenerator _pdfGenerator;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public OrderGenerationAgentService(
        ILogger<OrderGenerationAgentService> logger,
        IConfiguration configuration,
        TelemetryClient telemetryClient,
        OrderGenerationService orderGenService,
        ReceiptService receiptService,
        PdfReceiptGenerator pdfGenerator,
        FoundryAgentClient foundryClient)
    {
        _logger = logger;
        _configuration = configuration;
        _telemetryClient = telemetryClient;
        _orderGenService = orderGenService;
        _receiptService = receiptService;
        _pdfGenerator = pdfGenerator;
        _foundryClient = foundryClient;

        _agentId = configuration["AI_AGENT_ORDER_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_ORDER_ID environment variable is not set");
    }

    /// <summary>
    /// Generate one realistic order for the given persona.
    /// Returns a structured result with step-by-step log entries and the created order ID.
    /// Pass <paramref name="previousResponseId"/> to continue a refinement conversation
    /// (e.g. admin clicks 'Regenerate' to get an alternative order plan).
    /// </summary>
    public async Task<OrderGenerationResult> GenerateOrderAsync(
        string personaType,
        string? customPersona,
        int? seedCustomerId = null,
        Action<string, string>? onLog = null,
        string? previousResponseId = null,
        string? orderMode = null,
        int? storeId = null)
    {
        var result = new OrderGenerationResult();
        var startTime = DateTimeOffset.UtcNow;
        string rawResponse = string.Empty;

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
            Log("Initialising Azure AI Foundry order-generation agent...", "info");

            // ── Resolve seed customer for "existing-customer" persona ─────────
            CustomerProfile? seedProfile = null;
            if (personaType == "existing-customer" || orderMode == "no-order-customer" || orderMode == "cart-recovery")
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

                Log($"Loaded profile: {seedProfile.FirstName} {seedProfile.LastName} — CustomerID={resolvedCustomerId}, {seedProfile.OrderCount} orders, ${seedProfile.TotalSpend:N2} total spend", "info");
            }

            var expectedCustomerMode = ResolveExpectedCustomerMode(orderMode, seedProfile);

            var personaDescription = orderMode switch
            {
                "no-order-customer" => seedProfile != null
                    ? $"Registered customer '{seedProfile.FirstName} {seedProfile.LastName}' (ID={seedProfile.CustomerID}) who browsed the site, registered an account, but never placed an order. They received a marketing email highlighting current sales and promotions. They are STRONGLY drawn to discounted/sale items — prioritise products with active SpecialOffers."
                    : "A registered customer who browsed, never purchased, and is now returning after a marketing email. Strongly drawn to sale items.",
                "cart-recovery" => seedProfile != null
                    ? $"Customer '{seedProfile.FirstName} {seedProfile.LastName}' (ID={seedProfile.CustomerID}) who abandoned their shopping cart and has now returned after receiving a Smart Cart Recovery email. They should purchase the items that were in their cart (check ShoppingCartItem for their saved items). Place those exact items as an order."
                    : "A customer returning to complete an abandoned cart purchase after a recovery email.",
                "b2b-store" => $"B2B store order (StoreID={storeId}). Generate a representative purchase order for this store based on their previous order history and current available stock. This is a business replenishment order, not a consumer purchase.",
                _ => seedProfile != null
                    ? BuildExistingCustomerPersona(seedProfile)
                    : BuildPersonaDescription(personaType, customPersona)
            };

            Log($"Planning order for persona: {personaDescription}", "info");

            var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

            // Build structured inputs to resolve Handlebars templates in the agent's Foundry
            // portal instructions. The two persona branches (existing-customer vs new-persona)
            // are handled in the agent instructions via {{#if isExistingCustomer}}...{{else}}...{{/if}}.
            // This replaces the dual userMessage string construction that was here before.
            var structuredInputs = new Dictionary<string, object>
            {
                ["todayDate"]          = today,
                ["personaDescription"] = personaDescription,
                ["isExistingCustomer"] = seedProfile != null,
                ["orderMode"]          = orderMode ?? "new-persona",
                ["storeId"]            = storeId ?? 0,
                ["expectedCustomerMode"] = expectedCustomerMode,
                ["requiresExistingCustomer"] = expectedCustomerMode == CustomerModeExisting,
                ["requiresNewCustomer"] = expectedCustomerMode == CustomerModeNew,
                ["isB2BStore"] = expectedCustomerMode == CustomerModeStore
            };

            if (seedProfile != null)
            {
                var recentProducts = seedProfile.RecentProducts.Any()
                    ? string.Join(", ", seedProfile.RecentProducts.Take(10))
                    : "no recent orders";
                structuredInputs["customerName"]    = $"{seedProfile.FirstName} {seedProfile.LastName}";
                structuredInputs["customerId"]      = seedProfile.CustomerID;
                structuredInputs["orderCount"]      = seedProfile.OrderCount;
                structuredInputs["totalSpend"]      = seedProfile.TotalSpend.ToString("N2");
                structuredInputs["recentProducts"]  = recentProducts;
            }

            // Scope Foundry memory per persona type so the agent recalls what it recently
            // generated and produces more varied orders across successive admin runs.
            // For a specific existing customer, scope to that customer ID instead.
            var memoryUserId = seedProfile != null
                ? $"order-gen-customer-{seedProfile.CustomerID}"
                : $"order-gen-persona-{personaType}";

            // The user message is a short constant — all dynamic context lives in
            // structured_inputs which resolve the Handlebars templates in the agent instructions.
            const string userMessage = "Generate a realistic purchase order following the instructions.";

            Log("AI agent reasoning over catalogue, promotions, and customers...", "dim");

            // Invoke the Foundry agent via the Responses API.
            // Passing previousResponseId continues a stored conversation so the admin can
            // trigger a refinement run (different plan for the same persona) without losing context.
            // tool_choice: "required" ensures the agent always calls MCP tools — preventing
            // hallucinated catalog data from being written to the database as real orders.
            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId!,
                userMessage: userMessage,
                userId: memoryUserId,
                previousResponseId: string.IsNullOrEmpty(previousResponseId) ? null : previousResponseId,
                structuredInputs: structuredInputs,
                toolChoice: "required");
            rawResponse = agentResponse.ResponseText ?? string.Empty;

            if (agentResponse.ToolsUsed?.Count > 0)
                Log($"Agent used tools: {string.Join(", ", agentResponse.ToolsUsed)}", "dim");

            _logger.LogInformation("AI order plan raw response length: {Length}", rawResponse.Length);

            Log("AI finished reasoning — parsing order plan...", "dim");
            var plan = ParseOrderPlan(rawResponse);
            ValidateOrderPlan(plan, expectedCustomerMode, seedProfile);

            Log($"AI reasoning: {plan.AiReasoning}", "dim");
            Log($"Persona: {plan.PersonaSummary}", "info");

            // ── Resolve customer ─────────────────────────────────────────────
            int customerId;
            // B2B store orders don't need a consumer customer — they resolve it from StoreID later
            if (orderMode == "b2b-store")
            {
                // For B2B, we don't resolve a consumer customer here.
                // The store's CustomerID is resolved inside CreateStoreOrderAsync.
                customerId = 0; // placeholder — not used for B2B path
                var storeInfo = await _orderGenService.GetStoreInfoAsync(storeId ?? 0);
                result.CustomerName = storeInfo?.StoreName ?? $"Store #{storeId}";
                Log($"B2B store order for: {result.CustomerName} (StoreID={storeId})", "success");
            }
            // If we used a seed customer (existing-customer persona), always honour it
            else if (seedProfile != null)
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
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.ExistingCustomerNotFound,
                        $"AI plan referenced CustomerID={plan.ExistingCustomerId.Value}, but that customer does not exist");
                }
            }
            else if (plan.NewCustomer != null)
            {
                customerId = await CreateNewCustomer(plan, result, Log);
            }
            else
            {
                throw new OrderPlanValidationException(
                    OrderPlanFailureCodes.MissingCustomerIdentity,
                    "AI plan did not include required customer details");
            }

            // ── Validate items & check stock ─────────────────────────────────
            Log("Validating items and checking live inventory...", "info");
            var validItems = new List<OrderLineItem>();
            var orderItems = plan.OrderItems ?? new List<PlannedOrderItem>();

            foreach (var item in orderItems)
            {
                // Guard against out-of-range values in the AI-generated plan
                // (treats agent output as untrusted input per tool best practices).
                if (item.ProductId <= 0)
                {
                    Log($"  Skipping invalid item: ProductId={item.ProductId}", "dim");
                    continue;
                }
                var clampedQty = Math.Clamp(item.Quantity, 1, 10);

                var stock = await _orderGenService.GetProductStockAsync(item.ProductId);
                if (stock <= 0)
                {
                    Log($"  Skipping ProductID={item.ProductId} ({item.ProductName}): out of stock", "dim");
                    continue;
                }
                if (stock < clampedQty)
                {
                    Log($"  Reducing qty for ProductID={item.ProductId} ({item.ProductName}): stock={stock} < requested={clampedQty}", "dim");
                    clampedQty = stock;
                }

                var price = item.UnitPrice > 0 ? item.UnitPrice
                    : await _orderGenService.GetProductPriceAsync(item.ProductId);

                var rawOfferId = item.SpecialOfferID ?? 0;
                var offerId = rawOfferId > 0 ? rawOfferId
                    : await _orderGenService.GetBestSpecialOfferAsync(item.ProductId);

                validItems.Add(new OrderLineItem
                {
                    ProductId = item.ProductId,
                    Quantity = (short)clampedQty,
                    UnitPrice = price,
                    SpecialOfferID = offerId
                });

                var offerNote = offerId > 1 ? $" (promotion ID={offerId})" : "";
                Log($"  ✓ {item.ProductName} × {clampedQty} @ ${price:N2}{offerNote} — stock: {stock}", "success");
            }

            if (!validItems.Any())
                throw new OrderPlanValidationException(
                    OrderPlanFailureCodes.NoValidAiPlannedItems,
                    "AI plan did not contain any valid in-stock items after inventory validation");

            // ── Create the order ─────────────────────────────────────────────
            int salesOrderId;
            if (orderMode == "b2b-store" && storeId.HasValue && storeId.Value > 0)
            {
                Log($"Creating B2B store order for StoreID={storeId.Value}...", "info");
                var storeItems = validItems.Select(vi => new StoreOrderLineItem
                {
                    ProductId = vi.ProductId,
                    Quantity = vi.Quantity,
                    UnitPrice = vi.UnitPrice,
                    DiscountPct = 0m
                }).ToList();

                salesOrderId = await _orderGenService.CreateStoreOrderAsync(new CreateStoreOrderRequest
                {
                    StoreBusinessEntityId = storeId.Value,
                    Items = storeItems,
                    PurchaseOrderNumber = $"SIM-{DateTime.UtcNow:yyyyMMdd}-{Random.Shared.Next(1000, 9999)}",
                    Comment = "Simulated B2B replenishment order (AI-generated)"
                });
            }
            else
            {
                Log("Creating order in database...", "info");
                salesOrderId = await _orderGenService.CreateOrderAsync(new CreateOrderRequest
                {
                    CustomerId = customerId,
                    Items = validItems
                });
            }

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
            result.Success   = true;
            result.TotalDue  = receiptData?.TotalDue
                ?? validItems.Sum(vi => vi.UnitPrice * vi.Quantity);
            result.CustomerId = customerId;
            result.ThreadId  = agentResponse.ResponseId;
            operation.Telemetry.Success = true;

            _telemetryClient.TrackEvent("OrderGeneration.Success", new Dictionary<string, string>
            {
                ["PersonaType"] = personaType,
                ["CustomerId"] = customerId.ToString(),
                ["SalesOrderId"] = salesOrderId.ToString(),
                ["ItemCount"] = validItems.Count.ToString(),
                ["DurationMs"] = duration.TotalMilliseconds.ToString("F0"),
                ["ThreadId"] = agentResponse.ResponseId ?? string.Empty
            });

            Log($"Done! Order #{salesOrderId} created for {result.CustomerName} — Total: ${result.TotalDue:N2}", "success");

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Order generation failed for persona={Persona}", personaType);
            operation.Telemetry.Success = false;
            var failureCode = ex switch
            {
                OrderPlanValidationException validationEx => validationEx.FailureCode,
                JsonException => OrderPlanFailureCodes.InvalidJson,
                _ => OrderPlanFailureCodes.UnhandledError,
            };
            result.FailureCode = failureCode;

            if (!string.IsNullOrWhiteSpace(rawResponse))
            {
                var preview = rawResponse.Length > 400 ? rawResponse[..400] + "..." : rawResponse;
                _logger.LogWarning("AI order plan failure code={FailureCode}; raw response preview: {Preview}", failureCode, preview);
            }

            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "OrderGeneration.Generate",
                ["PersonaType"] = personaType,
                ["FailureCode"] = failureCode
            });

            Log($"Error [{failureCode}]: {ex.Message}", "error");
            result.ErrorMessage = ex.Message;
            return result;
        }
    }

    // ── Direct order generation (no AI agent) ────────────────────────────────

    private async Task<int> CreateNewCustomer(
        OrderPlan plan,
        OrderGenerationResult result,
        Action<string, string> log)
    {
        var nc = plan.NewCustomer
            ?? throw new OrderPlanValidationException(
                OrderPlanFailureCodes.MissingCustomerIdentity,
                "AI plan did not provide a newCustomer payload");

        var firstName = nc.FirstName;
        var lastName = nc.LastName;
        var email = nc.Email;
        var addressLine1 = nc.AddressLine1;
        var city = nc.City;
        var stateCode = nc.StateCode;
        var postalCode = nc.PostalCode;

        log($"Creating new customer: {firstName} {lastName} ({email})", "info");

        var customerId = await _orderGenService.CreateCustomerAsync(new NewCustomerRequest
        {
            FirstName = firstName!,
            LastName = lastName!,
            Email = email,
            AddressLine1 = addressLine1!,
            City = city!,
            StateCode = stateCode,
            PostalCode = postalCode!,
            Password = nc.Password,
        });

        await _orderGenService.AddPersonPhoneAsync(
            new NewCustomerRequest { FirstName = firstName!, LastName = lastName! },
            nc.Phone!, customerId);
        log($"  Phone saved: {nc.Phone}", "dim");

        await _orderGenService.AddCreditCardAsync(
            customerId,
            nc.CreditCardType!,
            nc.CreditCardNumber!,
            nc.CreditCardExpMonth!.Value,
            nc.CreditCardExpYear!.Value);
        var last4 = nc.CreditCardNumber!.Length >= 4 ? nc.CreditCardNumber[^4..] : nc.CreditCardNumber;
        log($"  Credit card saved: {nc.CreditCardType} ****{last4}", "dim");

        result.CustomerName = $"{firstName} {lastName}";
        result.CustomerEmail = email;
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
        var cleaned = rawResponse.Trim();
        if (string.IsNullOrWhiteSpace(cleaned))
            throw new OrderPlanValidationException(OrderPlanFailureCodes.EmptyResponse, "AI returned an empty order plan response");

        // Strip markdown code fences if the model added them
        cleaned = Regex.Replace(cleaned, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
        cleaned = Regex.Replace(cleaned, @"```\s*$", "", RegexOptions.Multiline).Trim();

        // Extract the first complete JSON object using brace-depth matching
        var start = cleaned.IndexOf('{');
        if (start < 0)
            throw new OrderPlanValidationException(OrderPlanFailureCodes.InvalidJson, "AI order plan does not contain a JSON object");

        int depth = 0;
        bool inString = false;
        bool escape = false;
        int end = -1;
        for (int i = start; i < cleaned.Length; i++)
        {
            char c = cleaned[i];
            if (escape) { escape = false; continue; }
            if (c == '\\' && inString) { escape = true; continue; }
            if (c == '"') { inString = !inString; continue; }
            if (inString) continue;
            if (c == '{') depth++;
            else if (c == '}')
            {
                depth--;
                if (depth == 0) { end = i; break; }
            }
        }

        if (end < 0)
            throw new OrderPlanValidationException(OrderPlanFailureCodes.InvalidJson, "AI order plan contains an unclosed JSON object");

        cleaned = cleaned[start..(end + 1)];

        using var document = JsonDocument.Parse(cleaned);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new OrderPlanValidationException(OrderPlanFailureCodes.InvalidJson, "AI order plan must be a single JSON object");

        return JsonSerializer.Deserialize<OrderPlan>(cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("AI returned unparseable JSON for order plan");
    }

    private static string ResolveExpectedCustomerMode(string? orderMode, CustomerProfile? seedProfile)
    {
        if (orderMode == "b2b-store") return CustomerModeStore;
        if (seedProfile != null) return CustomerModeExisting;
        return CustomerModeNew;
    }

    private static void ValidateOrderPlan(OrderPlan plan, string expectedCustomerMode, CustomerProfile? seedProfile)
    {
        if (string.IsNullOrWhiteSpace(plan.CustomerMode))
            throw new OrderPlanValidationException(OrderPlanFailureCodes.MissingCustomerMode, "AI plan did not specify customerMode");

        var customerMode = plan.CustomerMode.Trim().ToLowerInvariant();
        if (!string.Equals(customerMode, expectedCustomerMode, StringComparison.Ordinal))
            throw new OrderPlanValidationException(
                OrderPlanFailureCodes.UnexpectedCustomerMode,
                $"AI plan specified customerMode='{plan.CustomerMode}', expected '{expectedCustomerMode}'");

        if (plan.OrderItems == null || plan.OrderItems.Count == 0)
            throw new OrderPlanValidationException(OrderPlanFailureCodes.NoPlannedItems, "AI plan did not include any order items");

        switch (customerMode)
        {
            case CustomerModeStore:
                if (plan.ExistingCustomerId.HasValue || plan.NewCustomer != null)
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.InvalidStoreCustomerPayload,
                        "Store plans must not include existingCustomerId or newCustomer");
                break;

            case CustomerModeExisting:
                if (!plan.ExistingCustomerId.HasValue || plan.ExistingCustomerId.Value <= 0)
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.MissingCustomerIdentity,
                        "Existing-customer plans must include a positive existingCustomerId");

                if (plan.NewCustomer != null)
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.BothCustomerModesPresent,
                        "Existing-customer plans must not include a newCustomer payload");

                if (seedProfile != null && plan.ExistingCustomerId.Value != seedProfile.CustomerID)
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.SeedCustomerMismatch,
                        $"AI plan returned existingCustomerId={plan.ExistingCustomerId.Value}, expected {seedProfile.CustomerID}");
                break;

            case CustomerModeNew:
                if (plan.ExistingCustomerId.HasValue)
                    throw new OrderPlanValidationException(
                        OrderPlanFailureCodes.BothCustomerModesPresent,
                        "New-customer plans must not include existingCustomerId");

                ValidateNewCustomerPlan(plan.NewCustomer);
                break;

            default:
                throw new OrderPlanValidationException(
                    OrderPlanFailureCodes.InvalidCustomerMode,
                    $"AI plan returned unsupported customerMode='{plan.CustomerMode}'");
        }
    }

    private static void ValidateNewCustomerPlan(NewCustomerPlan? newCustomer)
    {
        if (newCustomer == null)
            throw new OrderPlanValidationException(OrderPlanFailureCodes.MissingCustomerIdentity, "New-customer plans must include a newCustomer payload");

        RequireCustomerField(newCustomer.FirstName, nameof(newCustomer.FirstName));
        RequireCustomerField(newCustomer.LastName, nameof(newCustomer.LastName));
        RequireCustomerField(newCustomer.Email, nameof(newCustomer.Email));
        RequireCustomerField(newCustomer.Phone, nameof(newCustomer.Phone));
        RequireCustomerField(newCustomer.AddressLine1, nameof(newCustomer.AddressLine1));
        RequireCustomerField(newCustomer.City, nameof(newCustomer.City));
        RequireCustomerField(newCustomer.StateCode, nameof(newCustomer.StateCode));
        RequireCustomerField(newCustomer.PostalCode, nameof(newCustomer.PostalCode));
        RequireCustomerField(newCustomer.Password, nameof(newCustomer.Password));
        RequireCustomerField(newCustomer.CreditCardType, nameof(newCustomer.CreditCardType));
        RequireCustomerField(newCustomer.CreditCardNumber, nameof(newCustomer.CreditCardNumber));

        if (newCustomer.CreditCardExpMonth is null || newCustomer.CreditCardExpMonth < 1 || newCustomer.CreditCardExpMonth > 12)
            throw new OrderPlanValidationException(
                OrderPlanFailureCodes.InvalidNewCustomerPayload,
                "newCustomer.creditCardExpMonth must be between 1 and 12");

        if (newCustomer.CreditCardExpYear is null || newCustomer.CreditCardExpYear < DateTime.UtcNow.Year)
            throw new OrderPlanValidationException(
                OrderPlanFailureCodes.InvalidNewCustomerPayload,
                "newCustomer.creditCardExpYear must be the current year or later");
    }

    private static void RequireCustomerField(string? value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new OrderPlanValidationException(
                OrderPlanFailureCodes.InvalidNewCustomerPayload,
                $"AI plan omitted required field newCustomer.{fieldName}");
    }

    // The system prompt and tool configuration are managed in Azure AI Foundry on the agent definition.
    // No local system prompt is needed here.
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

public class OrderGenerationResult
{
    public bool Success { get; set; }
    public int SalesOrderId { get; set; }
    public int CustomerId { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerEmail { get; set; }
    public bool NewCustomerCreated { get; set; }
    public decimal TotalDue { get; set; }
    public string? ReceiptPdfBase64 { get; set; }
    public string? FailureCode { get; set; }
    public string? ErrorMessage { get; set; }
    public List<OrderGenLogEntry> Log { get; set; } = new();
    /// <summary>
    /// Foundry response ID. Pass back as previousResponseId in subsequent calls to continue
    /// the stored conversation (e.g. admin triggers a refinement/regeneration run).
    /// </summary>
    public string? ThreadId { get; set; }
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
    public string CustomerMode { get; set; } = string.Empty;
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
    public string? Phone { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City { get; set; }
    public string? StateCode { get; set; }
    public string? PostalCode { get; set; }
    public string? Password { get; set; }
    public string? CreditCardType { get; set; }
    public string? CreditCardNumber { get; set; }
    public byte? CreditCardExpMonth { get; set; }
    public short? CreditCardExpYear { get; set; }
}

public class PlannedOrderItem
{
    public int ProductId { get; set; }
    public string ProductName { get; set; } = string.Empty;
    public int Quantity { get; set; } = 1;
    public decimal UnitPrice { get; set; }
    public int? SpecialOfferID { get; set; }
    public string Reason { get; set; } = string.Empty;
}

public sealed class OrderPlanValidationException : InvalidOperationException
{
    public OrderPlanValidationException(string failureCode, string message)
        : base(message)
    {
        FailureCode = failureCode;
    }

    public string FailureCode { get; }
}

public static class OrderPlanFailureCodes
{
    public const string EmptyResponse = "empty_response";
    public const string InvalidJson = "invalid_json";
    public const string MissingCustomerMode = "missing_customer_mode";
    public const string InvalidCustomerMode = "invalid_customer_mode";
    public const string UnexpectedCustomerMode = "unexpected_customer_mode";
    public const string MissingCustomerIdentity = "missing_customer_identity";
    public const string BothCustomerModesPresent = "both_customer_modes_present";
    public const string SeedCustomerMismatch = "seed_customer_mismatch";
    public const string ExistingCustomerNotFound = "existing_customer_not_found";
    public const string InvalidNewCustomerPayload = "invalid_new_customer_payload";
    public const string InvalidStoreCustomerPayload = "invalid_store_customer_payload";
    public const string NoPlannedItems = "no_planned_items";
    public const string NoValidAiPlannedItems = "no_valid_ai_planned_items";
    public const string UnhandledError = "unhandled_error";
}
