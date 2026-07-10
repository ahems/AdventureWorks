using System.ComponentModel;
using System.Text.Json;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// MCP tools for generating random customer data for the shopping simulator.
/// Uses Bogus to produce realistic fake profiles with international addresses,
/// phone numbers, email addresses, passwords, and credit cards.
/// </summary>
[McpServerToolType]
public class CustomerGeneratorMcpTools
{
    private readonly CustomerGeneratorService _generator;
    private readonly TelemetryClient _telemetryClient;

    public CustomerGeneratorMcpTools(CustomerGeneratorService generator, TelemetryClient telemetryClient)
    {
        _generator = generator;
        _telemetryClient = telemetryClient;
    }

    [McpServerTool]
    [Description("Generate a complete random fictitious customer profile for the shopping simulator. " +
        "Returns a fully randomised customer with: first name, last name, realistic personal email address, " +
        "international cell phone number, full street address (line1, city, state/province code, postal code), " +
        "country (randomly selected from AdventureWorks supported cultures), a secure random password, " +
        "and a credit card (type, number, expiry month, expiry year). " +
        "All data is fake but realistic and culturally appropriate for the randomly chosen country. " +
        "Use this tool whenever you need to create a new customer for order simulation instead of inventing customer details yourself.")]
    public string GenerateRandomCustomer()
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GenerateRandomCustomer");
        try
        {
            var profile = _generator.GenerateRandomCustomer();
            op.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GenerateRandomCustomer" },
                { "country", profile.CountryCode }
            });

            return JsonSerializer.Serialize(profile, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GenerateRandomCustomer" } });
            throw;
        }
    }

    [McpServerTool]
    [Description("Generate a complete random fictitious customer profile for a specific locale/culture. " +
        "Accepts a locale code (e.g. 'fr', 'de', 'ja', 'en-gb', 'es', 'ko', 'ar', 'zh', 'th', 'id', etc.) " +
        "and returns a culturally appropriate fake customer profile with: first name, last name, " +
        "realistic personal email, international cell phone number, full address, country, " +
        "secure random password, and credit card details. " +
        "Use this when you need a customer from a specific country/culture for the shopping simulator.")]
    public string GenerateRandomCustomerForLocale(string locale)
    {
        using var op = _telemetryClient.StartOperation<RequestTelemetry>("MCP_GenerateRandomCustomerForLocale");
        op.Telemetry.Properties["locale"] = locale;
        try
        {
            var profile = _generator.GenerateRandomCustomerForLocale(locale);
            op.Telemetry.Success = true;
            _telemetryClient.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string>
            {
                { "tool", "GenerateRandomCustomerForLocale" },
                { "locale", locale },
                { "country", profile.CountryCode }
            });

            return JsonSerializer.Serialize(profile, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            op.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { { "tool", "GenerateRandomCustomerForLocale" } });
            throw;
        }
    }
}
