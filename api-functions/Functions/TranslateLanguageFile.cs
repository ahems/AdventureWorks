using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using System.Net;
using System.Text.Json;
using Azure.Storage.Blobs;
using Azure.Storage.Sas;
using Azure.Identity;

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

    [Function("TranslateLanguageFile_HttpStart")]
    public async Task<HttpResponseData> HttpStart(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
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
            _logger.LogInformation("Starting durable orchestration for translation to {Language} ({Code})", languageName, languageCode);

            // Start the orchestration
            var orchestrationInput = new TranslationOrchestrationInput
            {
                LanguageDataJson = JsonSerializer.Serialize(request.LanguageData),
                TargetLanguageCode = languageCode,
                TargetLanguageName = languageName
            };

            var instanceId = await client.ScheduleNewOrchestrationInstanceAsync(
                nameof(TranslateLanguageFile_Orchestrator),
                orchestrationInput);

            _logger.LogInformation("Started translation orchestration with ID = '{instanceId}'", instanceId);

            // Return simple response with instance ID for custom polling
            var response = req.CreateResponse(HttpStatusCode.Accepted);

            // Always use https in Container Apps (reverse proxy handles TLS)
            var statusUrl = $"https://{req.Url.Host}/api/TranslateLanguageFile_Status?instanceId={instanceId}";

            var responseData = new
            {
                id = instanceId,
                statusUrl = statusUrl
            };

            await response.WriteAsJsonAsync(responseData);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error starting translation orchestration");
            return await CreateErrorResponse(req, HttpStatusCode.InternalServerError,
                $"Internal server error: {ex.Message}");
        }
    }

    [Function("TranslateLanguageFile_Status")]
    public async Task<HttpResponseData> GetStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req,
        [DurableClient] DurableTaskClient client)
    {
        _logger.LogInformation("Status request received for URL: {Url}", req.Url);

        // Parse query string manually
        var queryString = req.Url.Query;
        var instanceId = "";

        if (!string.IsNullOrEmpty(queryString) && queryString.StartsWith("?"))
        {
            var pairs = queryString.Substring(1).Split('&');
            foreach (var pair in pairs)
            {
                var parts = pair.Split('=');
                if (parts.Length == 2 && parts[0] == "instanceId")
                {
                    instanceId = Uri.UnescapeDataString(parts[1]);
                    break;
                }
            }
        }

        if (string.IsNullOrEmpty(instanceId))
        {
            _logger.LogWarning("Missing instanceId in query string: {QueryString}", queryString);
            return await CreateErrorResponse(req, HttpStatusCode.BadRequest, "Missing instanceId parameter");
        }

        _logger.LogInformation("Looking up orchestration instance: {InstanceId}", instanceId);

        try
        {
            // Request full metadata including outputs
            var metadata = await client.GetInstanceAsync(instanceId, getInputsAndOutputs: true);

            if (metadata == null)
            {
                _logger.LogWarning("Instance not found: {InstanceId}", instanceId);
                return await CreateErrorResponse(req, HttpStatusCode.NotFound, $"Instance {instanceId} not found");
            }

            _logger.LogInformation("Instance {InstanceId} status: {Status}, SerializedOutput: '{Output}'",
                instanceId, metadata.RuntimeStatus, metadata.SerializedOutput ?? "(null)");

            var response = req.CreateResponse(HttpStatusCode.OK);

            var statusData = new
            {
                instanceId = metadata.InstanceId,
                runtimeStatus = metadata.RuntimeStatus.ToString(),
                createdTime = metadata.CreatedAt,
                lastUpdatedTime = metadata.LastUpdatedAt,
                output = metadata.SerializedOutput, // Return raw serialized output
                rawOutput = metadata.SerializedOutput, // Also include as rawOutput for debugging
                error = metadata.RuntimeStatus == OrchestrationRuntimeStatus.Failed
                    ? metadata.FailureDetails?.ErrorMessage
                    : null
            };

            await response.WriteAsJsonAsync(statusData);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting orchestration status for {InstanceId}", instanceId);
            return await CreateErrorResponse(req, HttpStatusCode.InternalServerError,
                $"Error retrieving status: {ex.Message}");
        }
    }

    [Function(nameof(TranslateLanguageFile_Orchestrator))]
    public async Task<string> TranslateLanguageFile_Orchestrator(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var logger = context.CreateReplaySafeLogger<TranslateLanguageFile>();
        var input = context.GetInput<TranslationOrchestrationInput>();

        if (input == null)
        {
            throw new ArgumentNullException(nameof(input), "Orchestration input is null");
        }

        try
        {
            logger.LogInformation("Starting translation orchestration for language {Language}", input.TargetLanguageName);

            // Parse the language data into sections
            var languageData = JsonSerializer.Deserialize<JsonElement>(input.LanguageDataJson);
            var sections = new Dictionary<string, JsonElement>();

            if (languageData.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in languageData.EnumerateObject())
                {
                    sections[property.Name] = property.Value;
                }
            }
            else
            {
                throw new InvalidOperationException("Language data must be a JSON object");
            }

            logger.LogInformation("Found {count} sections to translate", sections.Count);

            // Process all sections in parallel
            var sectionTasks = new List<Task<TranslatedSection>>();

            foreach (var section in sections)
            {
                logger.LogInformation("Queuing section '{Section}' for translation", section.Key);

                var sectionInput = new SectionTranslationInput
                {
                    SectionName = section.Key,
                    SectionDataJson = JsonSerializer.Serialize(section.Value),
                    TargetLanguageCode = input.TargetLanguageCode,
                    TargetLanguageName = input.TargetLanguageName
                };

                var task = context.CallActivityAsync<TranslatedSection>(
                    nameof(TranslateSectionActivity),
                    sectionInput);

                sectionTasks.Add(task);
            }

            logger.LogInformation("Waiting for {count} section tasks to complete", sectionTasks.Count);

            // Wait for all sections to complete
            var translatedSections = await Task.WhenAll(sectionTasks);

            logger.LogInformation("All {count} sections translated successfully", translatedSections.Length);
            logger.LogInformation("Translated sections: {Sections}", string.Join(", ", translatedSections.Select(s => s.SectionName)));

            // Reassemble the translated JSON
            // Build JSON manually from sections to avoid serialization issues
            var jsonParts = new List<string>();
            foreach (var section in translatedSections)
            {
                logger.LogInformation("Adding section '{Section}' (length: {length} chars)",
                    section.SectionName, section.TranslatedDataJson?.Length ?? 0);

                // Build JSON property: "sectionName": {...}
                jsonParts.Add($"\"{section.SectionName}\": {section.TranslatedDataJson}");
            }

            logger.LogInformation("Assembling final JSON from {count} sections", jsonParts.Count);

            var jsonResult = "{\n  " + string.Join(",\n  ", jsonParts) + "\n}";

            logger.LogInformation("Translation orchestration completed successfully. Result length: {Length} chars", jsonResult?.Length ?? 0);
            logger.LogInformation("Result preview: {Preview}", jsonResult != null ? jsonResult.Substring(0, Math.Min(200, jsonResult.Length)) : "null");

            // Save result to blob storage and get SAS URL
            var sasUrl = await context.CallActivityAsync<string>(
                nameof(SaveTranslationResultActivity),
                new TranslationResultInput
                {
                    InstanceId = context.InstanceId,
                    JsonResult = jsonResult,
                    TargetLanguageCode = input.TargetLanguageCode
                });

            logger.LogInformation("Translation result saved to blob storage with SAS URL");
            return sasUrl;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during translation orchestration");
            throw;
        }
    }

    [Function(nameof(TranslateSectionActivity))]
    public async Task<TranslatedSection> TranslateSectionActivity(
        [ActivityTrigger] SectionTranslationInput input,
        FunctionContext context)
    {
        var logger = context.GetLogger(nameof(TranslateSectionActivity));
        logger.LogInformation("Translating section '{Section}' to {Language}", input.SectionName, input.TargetLanguageName);

        var translatedPairs = new Dictionary<string, object>();

        // Parse the JSON string
        var sectionData = JsonSerializer.Deserialize<JsonElement>(input.SectionDataJson);

        // Process each key-value pair in the section
        await ProcessJsonElement(sectionData, "", translatedPairs, input, logger);

        var translatedDataJson = JsonSerializer.Serialize(translatedPairs, new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        });

        return new TranslatedSection
        {
            SectionName = input.SectionName,
            TranslatedDataJson = translatedDataJson
        };
    }

    private async Task ProcessJsonElement(
        JsonElement element,
        string currentPath,
        Dictionary<string, object> result,
        SectionTranslationInput input,
        ILogger logger)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var nestedObject = new Dictionary<string, object>();
                foreach (var property in element.EnumerateObject())
                {
                    var propertyPath = string.IsNullOrEmpty(currentPath)
                        ? property.Name
                        : $"{currentPath}.{property.Name}";

                    await ProcessJsonElement(property.Value, propertyPath, nestedObject, input, logger);
                }

                // Extract the last key from the path for nested objects
                var lastKey = currentPath.Contains('.') ? currentPath.Split('.').Last() : currentPath;
                if (!string.IsNullOrEmpty(lastKey))
                {
                    result[lastKey] = nestedObject;
                }
                else
                {
                    // Top-level properties
                    foreach (var kvp in nestedObject)
                    {
                        result[kvp.Key] = kvp.Value;
                    }
                }
                break;

            case JsonValueKind.String:
                var stringValue = element.GetString() ?? "";
                if (!string.IsNullOrWhiteSpace(stringValue))
                {
                    // Translate the string value
                    var translationInput = new ValueTranslationInput
                    {
                        SectionName = input.SectionName,
                        Key = currentPath,
                        Value = stringValue,
                        TargetLanguageCode = input.TargetLanguageCode,
                        TargetLanguageName = input.TargetLanguageName
                    };

                    var translated = await TranslateValueWithRetry(translationInput, logger);

                    var lastKeyString = currentPath.Contains('.') ? currentPath.Split('.').Last() : currentPath;
                    result[lastKeyString] = translated;
                }
                else
                {
                    var lastKeyEmpty = currentPath.Contains('.') ? currentPath.Split('.').Last() : currentPath;
                    result[lastKeyEmpty] = stringValue;
                }
                break;

            case JsonValueKind.Number:
            case JsonValueKind.True:
            case JsonValueKind.False:
            case JsonValueKind.Null:
                var lastKeySimple = currentPath.Contains('.') ? currentPath.Split('.').Last() : currentPath;
                result[lastKeySimple] = JsonSerializer.Deserialize<object>(element.GetRawText()) ?? "";
                break;

            case JsonValueKind.Array:
                var array = new List<object>();
                foreach (var item in element.EnumerateArray())
                {
                    var arrayItem = new Dictionary<string, object>();
                    await ProcessJsonElement(item, "", arrayItem, input, logger);
                    array.Add(arrayItem.Count == 1 ? arrayItem.Values.First() : arrayItem);
                }
                var lastKeyArray = currentPath.Contains('.') ? currentPath.Split('.').Last() : currentPath;
                result[lastKeyArray] = array;
                break;
        }
    }

    private async Task<string> TranslateValueWithRetry(
        ValueTranslationInput input,
        ILogger logger,
        int maxRetries = 5)
    {
        int retryCount = 0;
        int delayMs = 1000; // Start with 1 second

        while (retryCount < maxRetries)
        {
            try
            {
                return await _aiService.TranslateTextAsync(
                    input.Value,
                    input.TargetLanguageCode,
                    input.TargetLanguageName);
            }
            catch (Exception ex) when (IsRateLimitException(ex))
            {
                retryCount++;
                if (retryCount >= maxRetries)
                {
                    logger.LogError(ex, "Max retries reached for translating '{Key}' in section '{Section}'",
                        input.Key, input.SectionName);
                    throw;
                }

                logger.LogWarning("Rate limit hit for '{Key}' in section '{Section}'. Retry {Retry}/{Max} after {Delay}ms",
                    input.Key, input.SectionName, retryCount, maxRetries, delayMs);

                await Task.Delay(delayMs);
                delayMs *= 2; // Exponential backoff
            }
        }

        return input.Value; // Fallback to original value
    }

    private bool IsRateLimitException(Exception ex)
    {
        // Check for rate limiting indicators
        return ex.Message.Contains("429") ||
               ex.Message.Contains("rate limit", StringComparison.OrdinalIgnoreCase) ||
               ex.Message.Contains("quota", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<HttpResponseData> CreateErrorResponse(HttpRequestData req, HttpStatusCode statusCode, string message)
    {
        var response = req.CreateResponse(statusCode);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }

    [Function(nameof(SaveTranslationResultActivity))]
    public async Task<string> SaveTranslationResultActivity(
        [ActivityTrigger] TranslationResultInput input,
        FunctionContext context)
    {
        var logger = context.GetLogger(nameof(SaveTranslationResultActivity));
        logger.LogInformation("Saving translation result for instance {InstanceId}", input.InstanceId);

        try
        {
            // Try connection string first (for local dev)
            var connectionString = Environment.GetEnvironmentVariable("AzureWebJobsStorage");
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName");

            logger.LogInformation("AzureWebJobsStorage value: {Value}", connectionString ?? "null");
            logger.LogInformation("AzureWebJobsStorage__accountName value: {Value}", accountName ?? "null");

            BlobServiceClient blobServiceClient;

            if (!string.IsNullOrEmpty(connectionString) && !connectionString.Contains("__"))
            {
                logger.LogInformation("Using connection string for blob storage");
                blobServiceClient = new BlobServiceClient(connectionString);
            }
            else if (!string.IsNullOrEmpty(accountName))
            {
                logger.LogInformation("Using managed identity for blob storage with account: {AccountName}", accountName);
                blobServiceClient = new BlobServiceClient(
                    new Uri($"https://{accountName}.blob.core.windows.net"),
                    new DefaultAzureCredential());
            }
            else
            {
                throw new InvalidOperationException("Either AzureWebJobsStorage or AzureWebJobsStorage__accountName must be configured");
            }

            return await SaveToBlobAndGenerateSas(blobServiceClient, input, logger);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error saving translation result to blob storage");
            throw;
        }
    }

    private async Task<string> SaveToBlobAndGenerateSas(
        BlobServiceClient blobServiceClient,
        TranslationResultInput input,
        ILogger logger)
    {
        // Create or get container
        var containerName = "translation-outputs";
        var containerClient = blobServiceClient.GetBlobContainerClient(containerName);
        await containerClient.CreateIfNotExistsAsync();

        // Create blob name with timestamp
        var timestamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
        var blobName = $"{input.InstanceId}/{input.TargetLanguageCode}-{timestamp}.json";
        var blobClient = containerClient.GetBlobClient(blobName);

        // Upload JSON content
        using (var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(input.JsonResult)))
        {
            await blobClient.UploadAsync(stream, overwrite: true);
        }

        logger.LogInformation("Uploaded translation result to blob: {BlobName}", blobName);

        // Return the blob URL - client can access with their own credentials
        var blobUri = blobClient.Uri.ToString();
        logger.LogInformation("Returning blob URI: {Uri}", blobUri);
        return blobUri;
    }

    public class TranslationRequest
    {
        public JsonElement LanguageData { get; set; }
        public string TargetLanguage { get; set; } = string.Empty;
    }
}
