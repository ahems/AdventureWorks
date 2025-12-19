using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

public class TranslateLanguageFile
{
    private readonly ILogger<TranslateLanguageFile> _logger;
    private readonly AIService _aiService;

    // Supported languages for translation
    private static readonly Dictionary<string, string> SupportedLanguages = new()
    {
        { "es", "Spanish" },
        { "fr", "French" },
        { "de", "German" },
        { "pt", "Portuguese" },
        { "it", "Italian" },
        { "nl", "Dutch" },
        { "ru", "Russian" },
        { "zh", "Chinese (Mandarin)" },
        { "zh-cht", "Chinese (Traditional)" },
        { "ja", "Japanese" },
        { "ko", "Korean" },
        { "ar", "Arabic (Modern Standard Arabic)" },
        { "he", "Hebrew" },
        { "tr", "Turkish" },
        { "vi", "Vietnamese" },
        { "th", "Thai" },
        { "id", "Indonesian" },
        { "en-gb", "English (United Kingdom)" },
        { "en-ca", "English (Canada)" },
        { "en-au", "English (Australia)" },
        { "en-nz", "English (New Zealand)" },
        { "en-ie", "English (Ireland)" }
    };

    public TranslateLanguageFile(ILogger<TranslateLanguageFile> logger, AIService aiService)
    {
        _logger = logger;
        _aiService = aiService;
    }

    [Function("TranslateLanguageFile")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("Language file translation request received");

        try
        {
            // Read the request body
            string requestBody = await new StreamReader(req.Body).ReadToEndAsync();

            if (string.IsNullOrWhiteSpace(requestBody))
            {
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Request body is empty");
            }

            // Parse the request
            TranslationRequest? request;
            try
            {
                request = JsonSerializer.Deserialize<TranslationRequest>(requestBody, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                });
            }
            catch (JsonException ex)
            {
                _logger.LogError(ex, "Failed to parse request JSON");
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Invalid JSON in request body");
            }

            if (request == null)
            {
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Invalid request format");
            }

            if (request.LanguageData.ValueKind == JsonValueKind.Undefined || request.LanguageData.ValueKind == JsonValueKind.Null)
            {
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Missing languageData in request");
            }

            // Validate target language
            if (string.IsNullOrWhiteSpace(request.TargetLanguage))
            {
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Missing targetLanguage parameter");
            }

            var languageCode = request.TargetLanguage.ToLowerInvariant();
            if (!SupportedLanguages.ContainsKey(languageCode))
            {
                var supportedList = string.Join(", ", SupportedLanguages.Select(kvp => $"{kvp.Key} ({kvp.Value})"));
                return await CreateErrorResponse(req, HttpStatusCode.BadRequest,
                    $"Unsupported language: {request.TargetLanguage}. Supported languages: {supportedList}");
            }

            var languageName = SupportedLanguages[languageCode];
            _logger.LogInformation("Translating language file to {Language} ({Code})", languageName, languageCode);

            // Call AI service to translate
            var translatedData = await _aiService.TranslateLanguageFileAsync(
                request.LanguageData,
                languageCode,
                languageName);

            // Create successful response
            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Content-Type", "application/json; charset=utf-8");

            var jsonOptions = new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping // Preserve unicode characters
            };

            await response.WriteStringAsync(JsonSerializer.Serialize(translatedData, jsonOptions));

            _logger.LogInformation("Successfully translated language file to {Language}", languageName);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error translating language file");
            return await CreateErrorResponse(req, HttpStatusCode.InternalServerError,
                $"Internal server error: {ex.Message}");
        }
    }

    private async Task<HttpResponseData> CreateErrorResponse(HttpRequestData req, HttpStatusCode statusCode, string message)
    {
        var response = req.CreateResponse(statusCode);
        response.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }

    public class TranslationRequest
    {
        public JsonElement LanguageData { get; set; }
        public string TargetLanguage { get; set; } = string.Empty;
    }
}
