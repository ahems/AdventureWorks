using System.Text.Json;
using System.Text.RegularExpressions;
using Bogus;
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
    private readonly ILogger<OrderGenerationAgentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly TelemetryClient _telemetryClient;
    private readonly OrderGenerationService _orderGenService;
    private readonly ReceiptService _receiptService;
    private readonly PdfReceiptGenerator _pdfGenerator;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string? _agentId;

    /// <summary>True when AI_AGENT_ORDER_ID is configured and AI-driven generation is available.</summary>
    public bool IsAgentAvailable => !string.IsNullOrEmpty(_agentId);

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

        // Use the direct order-generation agent (AI_AGENT_ORDER_ID) for programmatic
        // order creation when available. Falls back to direct random generation when not set.
        _agentId = configuration["AI_AGENT_ORDER_ID"];
        if (string.IsNullOrEmpty(_agentId))
        {
            logger.LogWarning("AI_AGENT_ORDER_ID is not configured — order generation will use direct random mode (no AI)");
        }
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
        string? previousResponseId = null)
    {
        // When the AI agent is not configured, use direct random order generation
        if (!IsAgentAvailable)
        {
            return await GenerateOrderDirectAsync(personaType, seedCustomerId, onLog);
        }

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
            Log("Initialising Azure AI Foundry order-generation agent...", "info");

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

                // Log name and order stats only — omit email to avoid PII in log traces.
                // See: https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/tool-best-practice (Secure tool usage)
                Log($"Loaded profile: {seedProfile.FirstName} {seedProfile.LastName} — CustomerID={resolvedCustomerId}, {seedProfile.OrderCount} orders, ${seedProfile.TotalSpend:N2} total spend", "info");
            }

            var personaDescription = seedProfile != null
                ? BuildExistingCustomerPersona(seedProfile)
                : BuildPersonaDescription(personaType, customPersona);

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
                ["isExistingCustomer"] = seedProfile != null
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
            var rawResponse = agentResponse.ResponseText;

            if (agentResponse.ToolsUsed.Count > 0)
                Log($"Agent used tools: {string.Join(", ", agentResponse.ToolsUsed)}", "dim");

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
            {
                Log("All AI-planned items were out of stock — falling back to random in-stock products...", "dim");
                var fallbackProducts = await _orderGenService.GetRandomInStockProductsAsync(Random.Shared.Next(1, 4));

                if (fallbackProducts.Count == 0)
                    throw new InvalidOperationException("No in-stock products available for order generation");

                foreach (var product in fallbackProducts)
                {
                    var qty = (short)Math.Min(Random.Shared.Next(1, 4), Math.Max(1, product.Stock));
                    var offerId = await _orderGenService.GetBestSpecialOfferAsync(product.ProductID);

                    validItems.Add(new OrderLineItem
                    {
                        ProductId = product.ProductID,
                        Quantity = qty,
                        UnitPrice = product.ListPrice,
                        SpecialOfferID = offerId
                    });

                    var offerNote = offerId > 1 ? $" (promotion ID={offerId})" : "";
                    Log($"  ✓ {product.Name} × {qty} @ ${product.ListPrice:N2}{offerNote} (fallback)", "success");
                }
            }

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
            result.Success   = true;
            result.TotalDue  = receiptData?.TotalDue ?? 0;
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

    // ── Direct order generation (no AI agent) ────────────────────────────────

    /// <summary>
    /// Supported countries mapped to Bogus locale and phone prefix for random customer generation.
    /// Only includes countries whose cultures are supported by the AdventureWorks site.
    /// </summary>
    private static readonly (string CountryCode, string BogusLocale, string PhonePrefix)[] SupportedCountries =
    [
        ("US", "en",     "+1"),
        ("GB", "en_GB",  "+44"),
        ("CA", "en",     "+1"),
        ("AU", "en_AU",  "+61"),
        ("NZ", "en",     "+64"),
        ("IE", "en_IE",  "+353"),
        ("ES", "es",     "+34"),
        ("FR", "fr",     "+33"),
        ("DE", "de",     "+49"),
        ("PT", "pt_PT",  "+351"),
        ("IT", "it",     "+39"),
        ("NL", "nl",     "+31"),
        ("RU", "ru",     "+7"),
        ("JP", "ja",     "+81"),
        ("KR", "ko",     "+82"),
        ("TR", "tr",     "+90"),
    ];

    private static readonly string[] CardTypes = ["Vista", "SuperiorCard", "Distinguish", "ColonialVoice"];

    /// <summary>
    /// Generates an order directly by picking random in-stock products — no AI agent required.
    /// Used as a fallback when AI_AGENT_ORDER_ID is not configured.
    /// </summary>
    private async Task<OrderGenerationResult> GenerateOrderDirectAsync(
        string personaType,
        int? seedCustomerId,
        Action<string, string>? onLog)
    {
        var result = new OrderGenerationResult();
        var startTime = DateTimeOffset.UtcNow;

        void Log(string msg, string type = "info")
        {
            result.Log.Add(new OrderGenLogEntry { Message = msg, Type = type });
            onLog?.Invoke(msg, type);
            _logger.LogInformation("[OrderGen-Direct] {Message}", msg);
        }

        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("OrderGeneration.Direct");
        operation.Telemetry.Properties["PersonaType"] = personaType;

        try
        {
            Log("Using direct order generation (AI agent not configured)...", "info");

            // ── Resolve or create customer ───────────────────────────────────
            int customerId;
            if (personaType == "existing-customer" || (seedCustomerId.HasValue && seedCustomerId.Value > 0))
            {
                int resolvedId;
                if (seedCustomerId.HasValue && seedCustomerId.Value > 0)
                {
                    resolvedId = seedCustomerId.Value;
                }
                else
                {
                    var ids = await _orderGenService.GetCustomerIdsWithOrdersAsync(200);
                    if (ids.Count == 0)
                        throw new InvalidOperationException("No customers with orders found");
                    resolvedId = ids[Random.Shared.Next(ids.Count)];
                }

                var customer = await _orderGenService.GetCustomerAsync(resolvedId);
                if (customer != null)
                {
                    customerId = customer.CustomerID;
                    result.CustomerName = $"{customer.FirstName} {customer.LastName}";
                    result.CustomerEmail = customer.Email;
                    Log($"Using existing customer: {result.CustomerName} (ID={customerId})", "success");
                }
                else
                {
                    // Customer not found — create a new one instead
                    customerId = await CreateRandomCustomer(result, Log);
                }
            }
            else
            {
                // New customer persona
                customerId = await CreateRandomCustomer(result, Log);
            }

            // ── Pick random products ─────────────────────────────────────────
            var itemCount = Random.Shared.Next(1, 6); // 1–5 items per order
            Log($"Selecting {itemCount} random in-stock products...", "info");
            var products = await _orderGenService.GetRandomInStockProductsAsync(itemCount);

            if (products.Count == 0)
                throw new InvalidOperationException("No in-stock products available for order generation");

            var validItems = new List<OrderLineItem>();
            foreach (var product in products)
            {
                var qty = (short)Random.Shared.Next(1, 4); // 1–3 units
                if (qty > product.Stock) qty = (short)Math.Max(1, product.Stock);

                var offerId = await _orderGenService.GetBestSpecialOfferAsync(product.ProductID);

                validItems.Add(new OrderLineItem
                {
                    ProductId = product.ProductID,
                    Quantity = qty,
                    UnitPrice = product.ListPrice,
                    SpecialOfferID = offerId
                });

                var offerNote = offerId > 1 ? $" (promotion ID={offerId})" : "";
                Log($"  ✓ {product.Name} × {qty} @ ${product.ListPrice:N2}{offerNote}", "success");
            }

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
            var receiptData = await _receiptService.GetReceiptDataBySalesOrderIDAsync(salesOrderId);
            if (receiptData != null)
            {
                result.ReceiptPdfBase64 = await _pdfGenerator.GenerateReceiptPdfBase64Async(receiptData);
                Log("Receipt generated", "success");
            }

            var duration = DateTimeOffset.UtcNow - startTime;
            result.Success = true;
            result.TotalDue = receiptData?.TotalDue ?? 0;
            result.CustomerId = customerId;
            operation.Telemetry.Success = true;

            _telemetryClient.TrackEvent("OrderGeneration.Direct.Success", new Dictionary<string, string>
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
            _logger.LogError(ex, "Direct order generation failed for persona={Persona}", personaType);
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex);
            Log($"Error: {ex.Message}", "error");
            result.ErrorMessage = ex.Message;
            return result;
        }
    }

    private async Task<int> CreateRandomCustomer(OrderGenerationResult result, Action<string, string> log)
    {
        // Pick a random supported country and generate a complete profile using Bogus
        var country = SupportedCountries[Random.Shared.Next(SupportedCountries.Length)];
        var faker = new Faker(country.BogusLocale);

        var firstName = faker.Name.FirstName();
        var lastName = faker.Name.LastName();

        // Generate realistic email
        var emailDomains = new[] { "gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "protonmail.com", "icloud.com" };
        var emailDomain = emailDomains[Random.Shared.Next(emailDomains.Length)];
        var email = $"{firstName.ToLowerInvariant()}.{lastName.ToLowerInvariant()}{Random.Shared.Next(10, 999)}@{emailDomain}";

        // Generate international phone number
        var localPhone = faker.Phone.PhoneNumber();
        var digits = new string(localPhone.Where(char.IsDigit).ToArray());
        var localDigits = digits.Length > 10 ? digits[^10..] : digits.PadLeft(10, '0');
        var phone = $"{country.PhonePrefix} {localDigits[..3]} {localDigits[3..6]} {localDigits[6..]}";

        // Generate address
        var addressLine1 = faker.Address.StreetAddress();
        var city = faker.Address.City();
        var stateCode = faker.Address.StateAbbr();
        var postalCode = faker.Address.ZipCode();

        // Generate password
        var password = GenerateRandomPassword();

        log($"Creating new customer: {firstName} {lastName} ({email}) from {country.CountryCode}", "info");

        var customerId = await _orderGenService.CreateCustomerAsync(new NewCustomerRequest
        {
            FirstName = firstName,
            LastName = lastName,
            Email = email,
            AddressLine1 = addressLine1,
            City = city,
            StateCode = stateCode,
            PostalCode = postalCode,
            Password = password,
        });

        // Save phone
        await _orderGenService.AddPersonPhoneAsync(
            new NewCustomerRequest { FirstName = firstName, LastName = lastName },
            phone, customerId);

        // Save credit card
        var cardType = CardTypes[Random.Shared.Next(CardTypes.Length)];
        var cardNumber = GenerateLuhnCardNumber();
        var expMonth = (byte)Random.Shared.Next(1, 13);
        var expYear = (short)(DateTime.UtcNow.Year + Random.Shared.Next(1, 6));
        await _orderGenService.AddCreditCardAsync(customerId, cardType, cardNumber, expMonth, expYear);
        log($"  Card saved: {cardType} ****{cardNumber[^4..]}, Phone: {phone}", "dim");

        result.CustomerName = $"{firstName} {lastName}";
        result.CustomerEmail = email;
        result.NewCustomerCreated = true;
        log($"New customer created with CustomerID={customerId}", "success");
        return customerId;
    }

    private static string GenerateRandomPassword()
    {
        const string upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const string lower = "abcdefghijklmnopqrstuvwxyz";
        const string digits = "0123456789";
        const string special = "!@#$%^&*";
        const string all = upper + lower + digits + special;

        var length = Random.Shared.Next(12, 17);
        var password = new char[length];
        password[0] = upper[Random.Shared.Next(upper.Length)];
        password[1] = lower[Random.Shared.Next(lower.Length)];
        password[2] = digits[Random.Shared.Next(digits.Length)];
        password[3] = special[Random.Shared.Next(special.Length)];
        for (int i = 4; i < length; i++)
            password[i] = all[Random.Shared.Next(all.Length)];
        Random.Shared.Shuffle(password);
        return new string(password);
    }

    private static string GenerateLuhnCardNumber()
    {
        var prefixes = new[] { "4", "51", "52", "53", "54", "55", "37", "6011" };
        var prefix = prefixes[Random.Shared.Next(prefixes.Length)];
        var d = new int[16];
        for (int i = 0; i < prefix.Length; i++) d[i] = prefix[i] - '0';
        for (int i = prefix.Length; i < 15; i++) d[i] = Random.Shared.Next(10);
        var sum = 0;
        for (int i = 14; i >= 0; i--)
        {
            var v = d[i];
            if ((15 - i) % 2 == 1) { v *= 2; if (v > 9) v -= 9; }
            sum += v;
        }
        d[15] = (10 - (sum % 10)) % 10;
        return string.Join("", d);
    }

    private async Task<int> CreateNewCustomer(
        OrderPlan plan,
        OrderGenerationResult result,
        Action<string, string> log)
    {
        var nc = plan.NewCustomer!;
        log($"Creating new customer: {nc.FirstName} {nc.LastName} ({nc.Email})", "info");

        // If the AI agent didn't provide a password, generate one
        var password = nc.Password ?? GenerateRandomPassword();

        var customerId = await _orderGenService.CreateCustomerAsync(new NewCustomerRequest
        {
            FirstName = nc.FirstName,
            LastName = nc.LastName,
            Email = nc.Email,
            AddressLine1 = nc.AddressLine1 ?? "1 Main St",
            City = nc.City ?? "Seattle",
            StateCode = nc.StateCode,
            PostalCode = nc.PostalCode ?? "98101",
            Password = password,
        });

        // Save phone number — use agent-provided or generate one
        var phone = nc.Phone;
        if (string.IsNullOrWhiteSpace(phone))
        {
            var faker = new Faker("en");
            var digits = new string(faker.Phone.PhoneNumber().Where(char.IsDigit).ToArray());
            var localDigits = digits.Length > 10 ? digits[^10..] : digits.PadLeft(10, '0');
            phone = $"+1 {localDigits[..3]} {localDigits[3..6]} {localDigits[6..]}";
        }
        await _orderGenService.AddPersonPhoneAsync(
            new NewCustomerRequest { FirstName = nc.FirstName, LastName = nc.LastName },
            phone, customerId);
        log($"  Phone saved: {phone}", "dim");

        // Save credit card — use agent-provided or generate one
        var cardType = nc.CreditCardType ?? CardTypes[Random.Shared.Next(CardTypes.Length)];
        var cardNumber = nc.CreditCardNumber ?? GenerateLuhnCardNumber();
        var expMonth = nc.CreditCardExpMonth ?? (byte)Random.Shared.Next(1, 13);
        var expYear = nc.CreditCardExpYear ?? (short)(DateTime.UtcNow.Year + Random.Shared.Next(1, 6));
        await _orderGenService.AddCreditCardAsync(customerId, cardType, cardNumber, expMonth, expYear);
        log($"  Credit card saved: {cardType} ****{cardNumber[^4..]}", "dim");

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

        if (start < 0 || end <= start)
        {
            var preview = cleaned.Length > 200 ? cleaned[..200] + "..." : cleaned;
            throw new InvalidOperationException(
                $"AI returned text instead of a JSON order plan. Response preview: '{preview}'");
        }

        cleaned = cleaned.Substring(start, end - start + 1);

        return JsonSerializer.Deserialize<OrderPlan>(cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("AI returned unparseable JSON for order plan");
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
