using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using System.Net;
using System.Text.Json;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

public class TranslatePromotionDescriptions
{
    private readonly ILogger<TranslatePromotionDescriptions> _logger;
    private readonly ProductService _productService;
    private readonly SpecialOfferService _specialOfferService;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    // CultureID prefix that indicates an English-variant culture (no translation needed)
    private const string EnglishCultureID = "en    ";

    public TranslatePromotionDescriptions(
        ILogger<TranslatePromotionDescriptions> logger,
        ProductService productService,
        SpecialOfferService specialOfferService,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _productService = productService;
        _specialOfferService = specialOfferService;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    [Function("TranslatePromotion")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("TranslatePromotion function triggered");

        PromotionTranslationRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<PromotionTranslationRequest>();
            if (request == null || string.IsNullOrWhiteSpace(request.Description))
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteAsJsonAsync(new PromotionTranslationResult
                {
                    Success = false,
                    Message = "Request body must include a valid PromotionTranslationRequest with a Description."
                });
                return badRequest;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize PromotionTranslationRequest");
            var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequest.WriteAsJsonAsync(new PromotionTranslationResult
            {
                Success = false,
                Message = $"Invalid request body: {ex.Message}"
            });
            return badRequest;
        }

        _logger.LogInformation(
            "Translating SpecialOffer {SpecialOfferID}: '{Description}'",
            request.SpecialOfferID, request.Description);

        try
        {
            // Fetch all cultures from the DB except English US (already saved by the frontend)
            var allCultures = await _productService.GetSupportedCulturesAsync();
            // GetSupportedCulturesAsync returns CultureID != 'en', which (for nchar(6)) excludes "en    "
            // This gives us the 22 non-en cultures.

            // Split: English-variant cultures (copy verbatim) vs. non-English cultures (translate via AI)
            var englishVariantCultures = allCultures
                .Where(c => c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                .ToList();

            var nonEnglishCultures = allCultures
                .Where(c => !c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                .ToList();

            _logger.LogInformation(
                "Cultures to process: {NonEnglish} non-English (AI), {EnVariants} English-variant (verbatim)",
                nonEnglishCultures.Count, englishVariantCultures.Count);

            // Translate non-English cultures via AI (one batch call)
            var aiTranslations = await _aiService.TranslateTextAsync(
                request.Description,
                "Sales promotion description for an outdoor adventure equipment retailer",
                nonEnglishCultures);

            _logger.LogInformation("AI returned {Count} translations", aiTranslations.Count);

            // Parse dates
            var startDate = DateTime.TryParse(request.StartDate, out var sd) ? sd : DateTime.UtcNow;
            var endDate = DateTime.TryParse(request.EndDate, out var ed) ? ed : DateTime.UtcNow.AddYears(1);

            int culturesProcessed = 0;

            // Upsert non-English translated records
            foreach (var culture in nonEnglishCultures)
            {
                // Match the culture from AI result by trimmed CultureID
                var aiResult = aiTranslations.FirstOrDefault(
                    t => string.Equals(t.CultureID?.Trim(), culture.CultureID.Trim(), StringComparison.OrdinalIgnoreCase));

                var description = !string.IsNullOrWhiteSpace(aiResult?.TranslatedText)
                    ? aiResult.TranslatedText
                    : request.Description; // Fallback to English if translation missing

                if (string.IsNullOrWhiteSpace(aiResult?.TranslatedText))
                {
                    _logger.LogWarning(
                        "No AI translation returned for culture {CultureID}, using English fallback",
                        culture.CultureID);
                }

                await _specialOfferService.UpsertSpecialOfferAsync(
                    request.SpecialOfferID,
                    culture.CultureID,
                    description,
                    request.DiscountPct,
                    request.Type,
                    request.Category,
                    startDate,
                    endDate,
                    request.MinQty,
                    request.MaxQty);

                culturesProcessed++;
            }

            // Upsert English-variant records (verbatim copy of English description)
            foreach (var culture in englishVariantCultures)
            {
                await _specialOfferService.UpsertSpecialOfferAsync(
                    request.SpecialOfferID,
                    culture.CultureID,
                    request.Description,
                    request.DiscountPct,
                    request.Type,
                    request.Category,
                    startDate,
                    endDate,
                    request.MinQty,
                    request.MaxQty);

                culturesProcessed++;
            }

            _logger.LogInformation(
                "TranslatePromotion completed: {Count} cultures upserted for SpecialOfferID {ID}",
                culturesProcessed, request.SpecialOfferID);

            _telemetryClient.TrackEvent("PromotionTranslated", new Dictionary<string, string>
            {
                ["SpecialOfferID"] = request.SpecialOfferID.ToString(),
                ["CulturesProcessed"] = culturesProcessed.ToString()
            });

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new PromotionTranslationResult
            {
                Success = true,
                CulturesProcessed = culturesProcessed,
                Message = $"Successfully translated to {culturesProcessed} cultures."
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TranslatePromotion failed for SpecialOfferID {ID}", request.SpecialOfferID);
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "TranslatePromotion",
                ["SpecialOfferID"] = request.SpecialOfferID.ToString()
            });

            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new PromotionTranslationResult
            {
                Success = false,
                Message = ex.Message
            });
            return error;
        }
    }
}
