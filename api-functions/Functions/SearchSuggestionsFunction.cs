using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using System.Web;

namespace api_functions.Functions;

public class SearchSuggestionsFunction
{
    private readonly ILogger<SearchSuggestionsFunction> _logger;
    private readonly AIService _aiService;
    private readonly ProductService _productService;
    private readonly ReviewService _reviewService;

    public SearchSuggestionsFunction(
        ILogger<SearchSuggestionsFunction> logger,
        AIService aiService,
        ProductService productService,
        ReviewService reviewService)
    {
        _logger = logger;
        _aiService = aiService;
        _productService = productService;
        _reviewService = reviewService;
    }

    /// <summary>
    /// Search suggestions endpoint that provides AI-powered type-ahead completions
    /// </summary>
    /// <param name="req">HTTP request with query parameter 'q' for partial search text</param>
    /// <returns>List of suggested search queries</returns>
    /// <response code="200">Suggestions generated successfully</response>
    /// <response code="400">Missing or invalid query parameter</response>
    /// <response code="500">Internal server error</response>
    [Function("GetSearchSuggestions")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "search/suggestions")] HttpRequestData req)
    {
        try
        {
            // Parse query parameter
            var query = HttpUtility.ParseQueryString(req.Url.Query).Get("q");

            if (string.IsNullOrWhiteSpace(query))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Query parameter 'q' is required" });
                return badRequestResponse;
            }

            // Require at least 2 characters to avoid too many results
            if (query.Length < 2)
            {
                var response = req.CreateResponse(HttpStatusCode.OK);
                await response.WriteAsJsonAsync(new
                {
                    query = query,
                    suggestions = Array.Empty<string>()
                });
                return response;
            }

            _logger.LogInformation("Generating search suggestions for: {Query}", query);

            // Generate embedding for the partial query
            var queryEmbedding = await _aiService.GenerateQueryEmbeddingAsync(query);

            // Search both descriptions and reviews with a smaller result set
            var descriptionSearchTask = _productService.SearchProductsByDescriptionEmbeddingAsync(
                queryEmbedding,
                topN: 10 // Get top 10 matches
            );

            var reviewSearchTask = _reviewService.SearchProductsByReviewEmbeddingAsync(
                queryEmbedding,
                topN: 10 // Get top 10 matches
            );

            await Task.WhenAll(descriptionSearchTask, reviewSearchTask);

            var descriptionResults = await descriptionSearchTask;
            var reviewResults = await reviewSearchTask;

            // Extract unique, relevant suggestions from the results
            var suggestions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // Add product names that match well
            foreach (var result in descriptionResults.Take(5))
            {
                if (!string.IsNullOrWhiteSpace(result.Name))
                {
                    // Add full product name
                    suggestions.Add(result.Name);

                    // Extract key terms from product name (e.g., "Mountain Bike" from "Mountain-200 Black, 42")
                    var terms = ExtractKeyTerms(result.Name);
                    foreach (var term in terms)
                    {
                        if (term.Length >= query.Length &&
                            term.Contains(query, StringComparison.OrdinalIgnoreCase))
                        {
                            suggestions.Add(term);
                        }
                    }
                }

                // Add color suggestions if available
                if (!string.IsNullOrWhiteSpace(result.Color))
                {
                    var colorTerm = $"{result.Color} {ExtractProductType(result.Name)}";
                    suggestions.Add(colorTerm.Trim());
                }
            }

            // Add suggestions from review matches (e.g., "great for hiking")
            foreach (var result in reviewResults.Take(3))
            {
                if (!string.IsNullOrWhiteSpace(result.MatchText))
                {
                    var reviewTerms = ExtractSearchablePhrasesFromReview(result.MatchText, query);
                    foreach (var term in reviewTerms)
                    {
                        suggestions.Add(term);
                    }
                }
            }

            // Return top suggestions, prioritizing shorter, more specific terms
            var finalSuggestions = suggestions
                .Where(s => s.Length >= query.Length) // Only suggest completions
                .OrderBy(s => s.Length) // Prefer shorter suggestions first
                .ThenBy(s => !s.Contains(query, StringComparison.OrdinalIgnoreCase) ? 1 : 0) // Prefer matches
                .Take(6) // Limit to 6 suggestions
                .ToList();

            _logger.LogInformation(
                "Generated {count} suggestions for query: {query}",
                finalSuggestions.Count,
                query
            );

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteAsJsonAsync(new
            {
                query = query,
                suggestions = finalSuggestions
            });

            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating search suggestions");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while generating suggestions" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Extract key terms from a product name
    /// E.g., "Mountain-200 Black, 42" -> ["Mountain-200", "Mountain", "Bike"]
    /// </summary>
    private List<string> ExtractKeyTerms(string productName)
    {
        var terms = new List<string>();

        // Split by common delimiters
        var parts = productName.Split(new[] { ',', '-', ' ' }, StringSplitOptions.RemoveEmptyEntries);

        foreach (var part in parts)
        {
            var cleaned = part.Trim();

            // Skip numbers and very short terms
            if (cleaned.Length < 3 || int.TryParse(cleaned, out _))
                continue;

            terms.Add(cleaned);
        }

        // Add common product type patterns
        if (productName.Contains("bike", StringComparison.OrdinalIgnoreCase))
            terms.Add("bikes");
        if (productName.Contains("jersey", StringComparison.OrdinalIgnoreCase))
            terms.Add("jerseys");
        if (productName.Contains("glove", StringComparison.OrdinalIgnoreCase))
            terms.Add("gloves");
        if (productName.Contains("helmet", StringComparison.OrdinalIgnoreCase))
            terms.Add("helmets");

        return terms;
    }

    /// <summary>
    /// Extract product type from product name
    /// E.g., "Mountain-200 Black, 42" -> "Mountain Bike"
    /// </summary>
    private string ExtractProductType(string productName)
    {
        // Common product type patterns
        if (productName.Contains("bike", StringComparison.OrdinalIgnoreCase))
            return "bikes";
        if (productName.Contains("jersey", StringComparison.OrdinalIgnoreCase))
            return "jerseys";
        if (productName.Contains("shorts", StringComparison.OrdinalIgnoreCase))
            return "shorts";
        if (productName.Contains("glove", StringComparison.OrdinalIgnoreCase))
            return "gloves";
        if (productName.Contains("helmet", StringComparison.OrdinalIgnoreCase))
            return "helmets";
        if (productName.Contains("tire", StringComparison.OrdinalIgnoreCase))
            return "tires";
        if (productName.Contains("wheel", StringComparison.OrdinalIgnoreCase))
            return "wheels";
        if (productName.Contains("pedal", StringComparison.OrdinalIgnoreCase))
            return "pedals";

        return "products";
    }

    /// <summary>
    /// Extract searchable phrases from review text
    /// E.g., from "great for hiking in the mountains" extract "hiking"
    /// </summary>
    private List<string> ExtractSearchablePhrasesFromReview(string reviewText, string query)
    {
        var phrases = new List<string>();

        // Common search patterns in reviews
        var patterns = new[]
        {
            "great for ",
            "perfect for ",
            "ideal for ",
            "best for ",
            "good for "
        };

        var lowerReview = reviewText.ToLower();

        foreach (var pattern in patterns)
        {
            var index = lowerReview.IndexOf(pattern);
            if (index >= 0)
            {
                // Extract the activity after the pattern (e.g., "hiking", "cycling")
                var afterPattern = reviewText.Substring(index + pattern.Length);
                var words = afterPattern.Split(new[] { ' ', ',', '.', '!', '?' }, StringSplitOptions.RemoveEmptyEntries);

                if (words.Length > 0)
                {
                    var activity = words[0].Trim();
                    if (activity.Length >= 4) // Reasonable length for an activity
                    {
                        phrases.Add($"{pattern}{activity}");
                    }
                }
            }
        }

        return phrases;
    }
}
