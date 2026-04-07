using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using Microsoft.ApplicationInsights;
using Azure.Identity;
using Azure.AI.OpenAI;
using OpenAI.Chat;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// AI-driven customer generation: pick a locale → AI invents a realistic name/address/email
/// → create the customer in the database.
/// POST /api/customers/generate-with-ai
/// Body: { "locale": "fr" | "de" | "ja" | ... }
/// Returns: { success, businessEntityId, salesCustomerId, firstName, lastName, email, phone, address, city, stateProvince, postalCode, country }
/// </summary>
public class GenerateCustomerWithAIFunction
{
    private readonly ILogger<GenerateCustomerWithAIFunction> _logger;
    private readonly IConfiguration _configuration;
    private readonly OrderGenerationService _orderGenService;
    private readonly TelemetryClient _telemetryClient;

    public GenerateCustomerWithAIFunction(
        ILogger<GenerateCustomerWithAIFunction> logger,
        IConfiguration configuration,
        OrderGenerationService orderGenService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _configuration = configuration;
        _orderGenService = orderGenService;
        _telemetryClient = telemetryClient;
    }

    [Function("GenerateCustomerWithAI")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "customers/generate-with-ai")] HttpRequestData req)
    {
        _logger.LogInformation("GenerateCustomerWithAI request received");
        var startTime = DateTimeOffset.UtcNow;

        try
        {
            var body = await new StreamReader(req.Body).ReadToEndAsync();
            var input = JsonSerializer.Deserialize<GenerateCustomerRequest>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var locale = input?.Locale ?? "en";

            // 1. Ask Azure OpenAI to invent a realistic customer for the locale
            var endpoint = _configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT not configured");
            var deployment = _configuration["chatGptDeploymentName"] ?? "chat";

            var credential = new DefaultAzureCredential();
            var chatClient = new AzureOpenAIClient(new Uri(endpoint), credential)
                .GetChatClient(deployment);

            var systemPrompt = """
                You are generating realistic fake customer profile data for a retail database.
                The data must look authentic but be completely fictitious.
                Always respond with valid JSON only, no markdown, no explanation.
                """;

            var userPrompt = $"Generate a completely fictitious customer profile appropriate for locale \"{locale}\".\n" +
                "Return JSON with exactly these fields:\n" +
                "{\n" +
                "  \"firstName\": \"...\",\n" +
                "  \"lastName\": \"...\",\n" +
                "  \"email\": \"...\",\n" +
                "  \"phone\": \"...\",\n" +
                "  \"addressLine1\": \"...\",\n" +
                "  \"city\": \"...\",\n" +
                "  \"stateCode\": \"...\",\n" +
                "  \"postalCode\": \"...\",\n" +
                "  \"country\": \"...\"\n" +
                "}\n\n" +
                "Requirements:\n" +
                "- firstName and lastName should be typical names for this locale/culture\n" +
                "- email should be firstname.lastname style with a plausible domain (gmail, yahoo, hotmail, or a local domain)\n" +
                "- phone should use the correct country code and format for that locale\n" +
                "- addressLine1 should be a realistic street address for that country\n" +
                "- city should be a real city in that country\n" +
                "- stateCode should be the 2-3 letter province/state code (use \"BC\" if the country has no states/provinces)\n" +
                "- postalCode should be in the correct format for the country\n" +
                "- country should be the full English name of the country";

            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt),
                new UserChatMessage(userPrompt)
            };

            var chatOptions = new ChatCompletionOptions
            {
                Temperature = 1.0f,
                MaxOutputTokenCount = 300
            };

            var completion = await chatClient.CompleteChatAsync(messages, chatOptions);
            var rawJson = completion.Value.Content[0].Text.Trim();

            // Strip markdown if present
            if (rawJson.StartsWith("```"))
            {
                rawJson = rawJson.Split('\n').Skip(1).TakeWhile(l => !l.StartsWith("```")).Aggregate("", (a, b) => a + "\n" + b).Trim();
            }

            var profile = JsonSerializer.Deserialize<AiGeneratedProfile>(rawJson,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("Failed to parse AI-generated profile");

            _logger.LogInformation("AI generated customer: {FirstName} {LastName} for locale {Locale}",
                profile.FirstName, profile.LastName, locale);

            // 2. Create the customer in the database
            var newReq = new NewCustomerRequest
            {
                FirstName = profile.FirstName ?? "New",
                LastName = profile.LastName ?? "Customer",
                Email = profile.Email,
                AddressLine1 = profile.AddressLine1 ?? "1 Main St",
                City = profile.City ?? "Seattle",
                StateCode = profile.StateCode,
                PostalCode = profile.PostalCode ?? "00000",
            };

            var salesCustomerId = await _orderGenService.CreateCustomerAsync(newReq);

            // 3. Add phone number (separate insert into PersonPhone)
            if (!string.IsNullOrWhiteSpace(profile.Phone))
            {
                await _orderGenService.AddPersonPhoneAsync(newReq, profile.Phone, salesCustomerId);
            }

            var duration = DateTimeOffset.UtcNow - startTime;
            _telemetryClient.TrackEvent("GenerateCustomerWithAI.Success", new Dictionary<string, string>
            {
                ["Locale"] = locale,
                ["Country"] = profile.Country ?? ""
            });

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                success = true,
                salesCustomerId,
                firstName = profile.FirstName,
                lastName = profile.LastName,
                email = profile.Email,
                phone = profile.Phone,
                address = profile.AddressLine1,
                city = profile.City,
                stateCode = profile.StateCode,
                postalCode = profile.PostalCode,
                country = profile.Country,
                locale,
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateCustomerWithAI");
            _telemetryClient.TrackException(ex, new Dictionary<string, string> { ["Endpoint"] = "GenerateCustomerWithAI" });

            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { success = false, error = ex.Message });
            return errorResponse;
        }
    }
}

public class GenerateCustomerRequest
{
    public string Locale { get; set; } = "en";
}

public class AiGeneratedProfile
{
    public string? FirstName { get; set; }
    public string? LastName { get; set; }
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City { get; set; }
    public string? StateCode { get; set; }
    public string? PostalCode { get; set; }
    public string? Country { get; set; }
}
