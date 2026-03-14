using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

public class SemanticSearchFunction
{
    private readonly ILogger<SemanticSearchFunction> _logger;
    private readonly AIService _aiService;
    private readonly ProductService _productService;
    private readonly ReviewService _reviewService;

    public SemanticSearchFunction(
        ILogger<SemanticSearchFunction> logger,
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
    /// Semantic search endpoint for products and reviews
    /// </summary>
    /// <param name="req">HTTP request with JSON body containing query, limit, and similarity threshold</param>
    /// <returns>Search results with product descriptions and reviews</returns>
    /// <response code="200">Search completed successfully</response>
    /// <response code="400">Invalid request body</response>
    /// <response code="500">Internal server error</response>
    [Function("SemanticSearch")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "search/semantic")] HttpRequestData req)
    {
        _logger.LogInformation("Semantic search request received");

        try
        {
            // Parse request body
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var searchRequest = JsonSerializer.Deserialize<SemanticSearchRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (searchRequest == null || string.IsNullOrWhiteSpace(searchRequest.Query))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Query parameter is required" });
                return badRequestResponse;
            }

            if (string.IsNullOrWhiteSpace(searchRequest.CultureId))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "CultureId parameter is required" });
                return badRequestResponse;
            }

            _logger.LogInformation("Searching for: {Query} (culture: {CultureId})", searchRequest.Query, searchRequest.CultureId);

            // Step 1: Generate embedding for the search query
            var queryEmbedding = await _aiService.GenerateQueryEmbeddingAsync(searchRequest.Query);

            // Step 2: Search descriptions, reviews, and product names in parallel
            var descriptionSearchTask = _productService.SearchProductsByDescriptionEmbeddingAsync(
                queryEmbedding,
                searchRequest.TopN ?? 10,
                searchRequest.CultureId
            );

            var reviewSearchTask = _reviewService.SearchProductsByReviewEmbeddingAsync(
                queryEmbedding,
                searchRequest.TopN ?? 10
            );

            var nameSearchTask = _productService.SearchProductsByNameEmbeddingAsync(
                queryEmbedding,
                searchRequest.TopN ?? 10,
                searchRequest.CultureId
            );

            await Task.WhenAll(descriptionSearchTask, reviewSearchTask, nameSearchTask);

            var descriptionResults = await descriptionSearchTask;
            var reviewResults = await reviewSearchTask;
            var nameResults = await nameSearchTask;

            // Step 3: Combine and deduplicate results — keep the best (lowest cosine distance) per product
            var combinedResults = new Dictionary<int, SemanticSearchResult>();

            foreach (var result in descriptionResults.Concat(reviewResults).Concat(nameResults))
            {
                if (!combinedResults.ContainsKey(result.ProductID))
                {
                    combinedResults[result.ProductID] = result;
                }
                else if (result.SimilarityScore < combinedResults[result.ProductID].SimilarityScore)
                {
                    combinedResults[result.ProductID] = result;
                }
            }

            // Step 4: Sort by similarity score and take top N
            var finalResults = combinedResults.Values
                .OrderBy(r => r.SimilarityScore)
                .Take(searchRequest.TopN ?? 10)
                .ToList();

            _logger.LogInformation(
                "Semantic search completed: {count} results (from {descCount} description matches, {reviewCount} review matches, {nameCount} name matches)",
                finalResults.Count,
                descriptionResults.Count,
                reviewResults.Count,
                nameResults.Count
            );

            // Return results
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                query = searchRequest.Query,
                results = finalResults,
                totalResults = finalResults.Count,
                descriptionMatches = descriptionResults.Count,
                reviewMatches = reviewResults.Count,
                nameMatches = nameResults.Count
            });

            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error performing semantic search");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while performing the search" });
            return errorResponse;
        }
    }
}

public class SemanticSearchRequest
{
    public string Query { get; set; } = string.Empty;
    public int? TopN { get; set; } = 10;
    public string CultureId { get; set; } = string.Empty;
}
