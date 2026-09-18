using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;

namespace api_functions.Services;

/// <summary>
/// Orchestrates an Azure AI Foundry Agent that generates a realistic, completely
/// fictitious customer profile for a given locale, then writes it to the database
/// via OrderGenerationService.
///
/// Foundry features used:
///   - structured_inputs    → locale and todayDate resolved via Handlebars templates
///                            in the agent instructions
///   - x-memory-user-id     → scopes memory per locale so successive runs for the
///                            same locale produce varied names, cities, and email domains
/// </summary>
public class CustomerGenerationAgentService
{
    private readonly ILogger<CustomerGenerationAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly OrderGenerationService _orderGenService;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public CustomerGenerationAgentService(
        ILogger<CustomerGenerationAgentService> logger,
        IConfiguration configuration,
        TelemetryClient telemetryClient,
        OrderGenerationService orderGenService,
        FoundryAgentClient foundryClient)
    {
        _logger = logger;
        _telemetryClient = telemetryClient;
        _orderGenService = orderGenService;
        _foundryClient = foundryClient;

        _agentId = configuration["AI_AGENT_CUSTOMER_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_CUSTOMER_ID environment variable is not set");
    }

    /// <summary>
    /// Generates a fictitious customer profile for the given locale, writes the
    /// customer to the database, and returns the persisted customer details.
    /// </summary>
    public async Task<GenerateCustomerResult> GenerateCustomerAsync(string locale)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("CustomerGeneration.Generate");
        operation.Telemetry.Properties["Locale"] = locale;

        var structuredInputs = new Dictionary<string, object>
        {
            ["locale"]    = locale,
            ["todayDate"] = DateTime.UtcNow.ToString("yyyy-MM-dd")
        };

        // Scope memory per locale so the agent recalls what it recently generated
        // and produces more varied profiles across successive admin runs.
        var memoryUserId = $"customer-gen-locale-{locale}";

        _logger.LogInformation("Invoking admin-customer-agent for locale {Locale}", locale);

        var agentResponse = await _foundryClient.InvokeAsync(
            agentId: _agentId,
            userMessage: "Generate a realistic customer profile following the instructions. You MUST call the generate_random_customer_for_locale tool to get the profile data.",
            userId: memoryUserId,
            previousResponseId: null,
            structuredInputs: structuredInputs,
            toolChoice: "auto");

        var rawJson = agentResponse.ResponseText.Trim();

        // Strip markdown code fences if the model wrapped the JSON
        if (rawJson.StartsWith("```"))
        {
            rawJson = Regex.Replace(rawJson, @"^```[a-z]*\n?", "", RegexOptions.Multiline);
            rawJson = rawJson.Replace("```", "").Trim();
        }

        var profile = JsonSerializer.Deserialize<AiGeneratedProfile>(rawJson,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("Failed to parse AI-generated customer profile from agent response");

        _logger.LogInformation("Agent generated customer: {FirstName} {LastName} for locale {Locale}",
            profile.FirstName, profile.LastName, locale);

        // Write the customer to the database
        var newReq = new NewCustomerRequest
        {
            FirstName    = profile.FirstName    ?? "New",
            LastName     = profile.LastName     ?? "Customer",
            Email        = profile.Email,
            AddressLine1 = profile.AddressLine1 ?? "1 Main St",
            City         = profile.City         ?? "Seattle",
            StateCode    = profile.StateCode,
            PostalCode   = profile.PostalCode   ?? "00000",
            Password     = profile.Password,
        };

        var salesCustomerId = await _orderGenService.CreateCustomerAsync(newReq);

        if (!string.IsNullOrWhiteSpace(profile.Phone))
        {
            await _orderGenService.AddPersonPhoneAsync(newReq, profile.Phone, salesCustomerId);
        }

        // Save credit card if provided
        if (!string.IsNullOrWhiteSpace(profile.CreditCardNumber) && !string.IsNullOrWhiteSpace(profile.CreditCardType)
            && profile.CreditCardExpMonth.HasValue && profile.CreditCardExpYear.HasValue)
        {
            await _orderGenService.AddCreditCardAsync(
                salesCustomerId, profile.CreditCardType, profile.CreditCardNumber,
                profile.CreditCardExpMonth.Value, profile.CreditCardExpYear.Value);
        }

        _telemetryClient.TrackEvent("GenerateCustomerWithAI.Success", new Dictionary<string, string>
        {
            ["Locale"]  = locale,
            ["Country"] = profile.Country ?? ""
        });

        return new GenerateCustomerResult
        {
            SalesCustomerId = salesCustomerId,
            FirstName       = profile.FirstName,
            LastName        = profile.LastName,
            Email           = profile.Email,
            Phone           = profile.Phone,
            Address         = profile.AddressLine1,
            City            = profile.City,
            StateCode       = profile.StateCode,
            PostalCode      = profile.PostalCode,
            Country         = profile.Country,
            Locale          = locale,
            CreditCardType  = profile.CreditCardType,
            CreditCardLast4 = profile.CreditCardNumber?.Length >= 4
                ? profile.CreditCardNumber[^4..] : null,
            CreditCardExpMonth = profile.CreditCardExpMonth,
            CreditCardExpYear  = profile.CreditCardExpYear,
        };
    }
}

public class GenerateCustomerResult
{
    public int     SalesCustomerId { get; init; }
    public string? FirstName       { get; init; }
    public string? LastName        { get; init; }
    public string? Email           { get; init; }
    public string? Phone           { get; init; }
    public string? Address         { get; init; }
    public string? City            { get; init; }
    public string? StateCode       { get; init; }
    public string? PostalCode      { get; init; }
    public string? Country         { get; init; }
    public string? Locale          { get; init; }
    public string? CreditCardType  { get; init; }
    public string? CreditCardLast4 { get; init; }
    public byte?   CreditCardExpMonth { get; init; }
    public short?  CreditCardExpYear  { get; init; }
}

public class AiGeneratedProfile
{
    public string? FirstName    { get; set; }
    public string? LastName     { get; set; }
    public string? Email        { get; set; }
    public string? Phone        { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City         { get; set; }
    public string? StateCode    { get; set; }
    public string? PostalCode   { get; set; }
    public string? Country      { get; set; }
    public string? Password     { get; set; }
    public string? CreditCardType   { get; set; }
    public string? CreditCardNumber { get; set; }
    public byte?   CreditCardExpMonth { get; set; }
    public short?  CreditCardExpYear  { get; set; }
}
