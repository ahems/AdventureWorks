using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Azure AI Foundry Agent service for generating personalised email
/// subjects and bodies for marketing/transactional emails.
///
/// Foundry features used:
///   - x-memory-user-id     → scopes memory per template type for consistent
///                            tone and style across email campaigns
///   - tool_choice: none    → customer context supplied in the user message
/// </summary>
public class EmailContentAgentService
{
    private readonly ILogger<EmailContentAgentService> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly FoundryAgentClient _foundryClient;
    private readonly string _agentId;

    public EmailContentAgentService(
        ILogger<EmailContentAgentService> logger,
        IConfiguration configuration,
        FoundryAgentClient foundryClient,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _foundryClient = foundryClient;
        _telemetryClient = telemetryClient;

        _agentId = configuration["AI_AGENT_EMAIL_CONTENT_ID"]
            ?? throw new InvalidOperationException(
                "AI_AGENT_EMAIL_CONTENT_ID environment variable is not set");
    }

    /// <summary>
    /// Generates a personalised email subject and body for the given template type and customer context.
    /// Returns an <see cref="EmailContent"/> with <see cref="EmailContent.Error"/> set if the agent call fails.
    /// </summary>
    public async Task<EmailContent> GenerateEmailContentAsync(EmailContentRequest request)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("EmailContentAgent.Generate");
        operation.Telemetry.Properties["TemplateType"] = request.TemplateType;

        try
        {
            var contextDetails = new System.Text.StringBuilder();
            contextDetails.AppendLine($"Customer first name: {request.FirstName}");
            contextDetails.AppendLine($"Template type: {request.TemplateType.Replace('_', ' ')}");
            if (request.TotalOrders.HasValue) contextDetails.AppendLine($"Total orders: {request.TotalOrders}");
            if (request.TotalSpent.HasValue) contextDetails.AppendLine($"Total spent: ${request.TotalSpent:F2}");
            if (request.CartValue.HasValue) contextDetails.AppendLine($"Abandoned cart value: ${request.CartValue:F2}");
            if (request.LastOrderId.HasValue) contextDetails.AppendLine($"Last order ID: {request.LastOrderId}");
            if (request.ProductNames?.Count > 0)
                contextDetails.AppendLine($"Relevant products: {string.Join(", ", request.ProductNames)}");

            var userMessage = $$"""
                Generate a personalised email subject and body for this customer.
                The tone should be warm, friendly, and on-brand for AdventureWorks (outdoor adventure equipment).
                Keep the body concise (3-5 short paragraphs).
                Return ONLY a valid JSON object: {"subject": "...", "body": "..."}

                {{contextDetails}}
                """;

            var memoryUserId = $"email-{request.TemplateType}";

            var agentResponse = await _foundryClient.InvokeAsync(
                agentId: _agentId,
                userMessage: userMessage,
                userId: memoryUserId,
                toolChoice: "none");

            var content = StripMarkdownFences(agentResponse.ResponseText ?? "{}");

            var result = JsonSerializer.Deserialize<EmailContent>(content,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            operation.Telemetry.Success = true;
            return result ?? new EmailContent { Error = "Empty response from agent" };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Email content generation failed for template {TemplateType}", request.TemplateType);
            operation.Telemetry.Success = false;
            return new EmailContent { Error = "Content generation unavailable" };
        }
    }

    private static string StripMarkdownFences(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.StartsWith("```"))
        {
            var firstNewline = trimmed.IndexOf('\n');
            if (firstNewline >= 0) trimmed = trimmed[(firstNewline + 1)..];
            if (trimmed.EndsWith("```")) trimmed = trimmed[..^3];
        }
        return trimmed.Trim();
    }
}
