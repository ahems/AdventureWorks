using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using System.Net;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP-triggered functions for category/subcategory management.
/// Handles fire-and-forget name translation and create/delete of categories/subcategories.
/// </summary>
public class CategoryManagementFunctions
{
    private readonly ILogger<CategoryManagementFunctions> _logger;
    private readonly ProductService _productService;
    private readonly AIService _aiService;
    private readonly TelemetryClient _telemetryClient;

    public CategoryManagementFunctions(
        ILogger<CategoryManagementFunctions> logger,
        ProductService productService,
        AIService aiService,
        TelemetryClient telemetryClient)
    {
        _logger = logger;
        _productService = productService;
        _aiService = aiService;
        _telemetryClient = telemetryClient;
    }

    // ── TranslateCategoryName ───────────────────────────────────────────────
    // Fire-and-forget: translates a category or subcategory name to all non-English cultures.

    [Function("TranslateCategoryName")]
    public async Task<HttpResponseData> TranslateCategoryName(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("TranslateCategoryName triggered");

        CategoryTranslationRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<CategoryTranslationRequest>();
            if (request == null || string.IsNullOrWhiteSpace(request.EnglishName) || request.CategoryId <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new CategoryTranslationResult { Success = false, Message = "Invalid request body." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize CategoryTranslationRequest");
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new CategoryTranslationResult { Success = false, Message = ex.Message });
            return bad;
        }

        try
        {
            var allCultures = await _productService.GetAllCulturesAsync();
            var nonEnglish = allCultures
                .Where(c => !c.CultureID.TrimEnd().Equals("en", StringComparison.OrdinalIgnoreCase)
                         && !c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                .ToList();
            var enVariants = allCultures
                .Where(c => c.CultureID.TrimEnd().StartsWith("en-", StringComparison.OrdinalIgnoreCase))
                .ToList();

            _logger.LogInformation("Translating {Type} '{Name}' to {Count} cultures",
                request.Type, request.EnglishName, nonEnglish.Count + enVariants.Count);

            var aiTranslations = await _aiService.TranslateTextAsync(
                request.EnglishName,
                $"Product {request.Type} name for an outdoor adventure sports equipment retailer",
                nonEnglish);

            int culturesProcessed = 0;

            // Save non-English translations
            foreach (var culture in nonEnglish)
            {
                var match = aiTranslations.FirstOrDefault(
                    t => string.Equals(t.CultureID?.Trim(), culture.CultureID.Trim(), StringComparison.OrdinalIgnoreCase));
                var name = !string.IsNullOrWhiteSpace(match?.TranslatedText) ? match!.TranslatedText : request.EnglishName;
                var trimmedName = name[..Math.Min(name.Length, 50)];

                if (request.Type == "subcategory")
                    await _productService.InsertSubcategoryRowAsync(request.CategoryId, 0, culture.CultureID, trimmedName);
                else
                    await _productService.InsertCategoryRowAsync(request.CategoryId, culture.CultureID, trimmedName);

                culturesProcessed++;
            }

            // Save English-variant cultures verbatim
            foreach (var culture in enVariants)
            {
                var trimmedName = request.EnglishName[..Math.Min(request.EnglishName.Length, 50)];
                if (request.Type == "subcategory")
                    await _productService.InsertSubcategoryRowAsync(request.CategoryId, 0, culture.CultureID, trimmedName);
                else
                    await _productService.InsertCategoryRowAsync(request.CategoryId, culture.CultureID, trimmedName);

                culturesProcessed++;
            }

            _logger.LogInformation("TranslateCategoryName: {Count} cultures saved for {Type} {Id}", culturesProcessed, request.Type, request.CategoryId);
            _telemetryClient.TrackEvent("CategoryNameTranslated", new Dictionary<string, string>
            {
                ["Type"] = request.Type,
                ["CategoryId"] = request.CategoryId.ToString(),
                ["CulturesProcessed"] = culturesProcessed.ToString()
            });

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new CategoryTranslationResult
            {
                Success = true,
                CulturesProcessed = culturesProcessed,
                Message = $"Successfully translated to {culturesProcessed} cultures."
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TranslateCategoryName failed for {Type} {Id}", request.Type, request.CategoryId);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new CategoryTranslationResult { Success = false, Message = ex.Message });
            return error;
        }
    }

    // ── CreateCategory ──────────────────────────────────────────────────────

    [Function("CreateCategory")]
    public async Task<HttpResponseData> CreateCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("CreateCategory triggered");

        CreateCategoryRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<CreateCategoryRequest>();
            if (request == null || string.IsNullOrWhiteSpace(request.EnglishName))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = "englishName is required." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = ex.Message });
            return bad;
        }

        try
        {
            var newId = await _productService.GetNextCategoryIdAsync();
            var trimmedName = request.EnglishName[..Math.Min(request.EnglishName.Length, 50)];

            // Insert English row
            await _productService.InsertCategoryRowAsync(newId, "en", trimmedName);

            _logger.LogInformation("Created category {Id} '{Name}'", newId, trimmedName);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new CreateEntityResult
            {
                Success = true,
                Id = newId,
                Message = $"Category '{trimmedName}' created with ID {newId}. Fire translation separately."
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CreateCategory failed");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = ex.Message });
            return error;
        }
    }

    // ── CreateSubcategory ───────────────────────────────────────────────────

    [Function("CreateSubcategory")]
    public async Task<HttpResponseData> CreateSubcategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("CreateSubcategory triggered");

        CreateSubcategoryRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<CreateSubcategoryRequest>();
            if (request == null || string.IsNullOrWhiteSpace(request.EnglishName) || request.CategoryId <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = "categoryId and englishName are required." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = ex.Message });
            return bad;
        }

        try
        {
            var newId = await _productService.GetNextSubcategoryIdAsync();
            var trimmedName = request.EnglishName[..Math.Min(request.EnglishName.Length, 50)];

            await _productService.InsertSubcategoryRowAsync(newId, request.CategoryId, "en", trimmedName);

            _logger.LogInformation("Created subcategory {Id} '{Name}' in category {CatId}", newId, trimmedName, request.CategoryId);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new CreateEntityResult
            {
                Success = true,
                Id = newId,
                Message = $"Subcategory '{trimmedName}' created with ID {newId}."
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CreateSubcategory failed");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new CreateEntityResult { Success = false, Message = ex.Message });
            return error;
        }
    }

    // ── GetSubcategoryProductCount ──────────────────────────────────────────

    [Function("GetSubcategoryProductCount")]
    public async Task<HttpResponseData> GetSubcategoryProductCount(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        DeleteEntityRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<DeleteEntityRequest>();
            if (request == null || request.Id <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { success = false, message = "id is required." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new { success = false, message = ex.Message });
            return bad;
        }

        try
        {
            var info = await _productService.GetSubcategoryProductInfoAsync(request.Id);
            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(info);
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetSubcategoryProductCount failed for {Id}", request.Id);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { success = false, message = ex.Message });
            return error;
        }
    }

    // ── DeleteCategory ──────────────────────────────────────────────────────

    [Function("DeleteCategory")]
    public async Task<HttpResponseData> DeleteCategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("DeleteCategory triggered");

        DeleteEntityRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<DeleteEntityRequest>();
            if (request == null || request.Id <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = "id is required." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = ex.Message });
            return bad;
        }

        try
        {
            var hasSubcats = await _productService.CategoryHasSubcategoriesAsync(request.Id);
            if (hasSubcats)
            {
                var conflict = req.CreateResponse(HttpStatusCode.Conflict);
                await conflict.WriteAsJsonAsync(new DeleteEntityResult
                {
                    Success = false,
                    Message = $"Category {request.Id} cannot be deleted: it still has subcategories. Delete all subcategories first."
                });
                return conflict;
            }

            await _productService.DeleteCategoryAsync(request.Id);
            _logger.LogInformation("Deleted category {Id}", request.Id);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new DeleteEntityResult { Success = true, Message = $"Category {request.Id} deleted." });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DeleteCategory failed for {Id}", request.Id);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = ex.Message });
            return error;
        }
    }

    // ── DeleteSubcategory ───────────────────────────────────────────────────

    [Function("DeleteSubcategory")]
    public async Task<HttpResponseData> DeleteSubcategory(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        _logger.LogInformation("DeleteSubcategory triggered");

        DeleteEntityRequest? request;
        try
        {
            request = await req.ReadFromJsonAsync<DeleteEntityRequest>();
            if (request == null || request.Id <= 0)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = "id is required." });
                return bad;
            }
        }
        catch (Exception ex)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = ex.Message });
            return bad;
        }

        try
        {
            var result = await _productService.DeleteSubcategoryCascadeAsync(request.Id);
            _logger.LogInformation("Deleted subcategory {Id} along with {Count} products", request.Id, result.ProductsDeleted);

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new DeleteEntityResult
            {
                Success = true,
                Message = result.ProductsDeleted > 0
                    ? $"Subcategory {request.Id} and {result.ProductsDeleted} product(s) deleted."
                    : $"Subcategory {request.Id} deleted."
            });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DeleteSubcategory failed for {Id}", request.Id);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new DeleteEntityResult { Success = false, Message = ex.Message });
            return error;
        }
    }
}
