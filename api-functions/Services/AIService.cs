using Azure.AI.OpenAI;
using Azure.Identity;
using api_functions.Models;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Extensions.Logging;
using OpenAI.Embeddings;
using OpenAI.Images;

namespace api_functions.Services;

// Helper class for JSON mode response
public class TranslationWrapper
{
    public List<TranslatedDescription>? Translations { get; set; }
}

public class TextTranslationWrapper
{
    public List<TextTranslation>? Translations { get; set; }
}

public class AIService
{
    private readonly string _endpoint;
    private readonly string _embeddingDeploymentName = "embedding";
    private readonly string _imageDeploymentName = "gpt-image-1";
    private readonly ILogger<AIService> _logger;
    private readonly TelemetryClient _telemetryClient;

    public AIService(string endpoint, ILogger<AIService> logger, TelemetryClient telemetryClient)
    {
        _endpoint = endpoint;
        _logger = logger;
        _telemetryClient = telemetryClient;
    }

    public async Task<List<ProductDescriptionEmbedding>> GenerateEmbeddingsAsync(List<ProductDescriptionData> descriptions)
    {
        using var operation = _telemetryClient.StartOperation<RequestTelemetry>("GenerateEmbeddings");
        operation.Telemetry.Properties["DescriptionCount"] = descriptions.Count.ToString();

        try
        {
            var credential = new DefaultAzureCredential();
            var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
            var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

            var embeddings = new List<ProductDescriptionEmbedding>();
            var startTime = DateTimeOffset.UtcNow;

            foreach (var description in descriptions)
            {
                // Create enriched text for embedding that includes variant information
                // This allows semantic search to find products by color, size, style, etc.
                var enrichedText = BuildEnrichedTextForEmbedding(description);

                _logger.LogInformation(
                    "Generating embedding for ProductDescriptionID {id} (Culture: {culture}, Original: {length} chars, Enriched: {enrichedLength} chars)",
                    description.ProductDescriptionID,
                    description.CultureID,
                    description.Description.Length,
                    enrichedText.Length
                );

                try
                {
                    ReadOnlyMemory<float> embeddingVector;
                    using (var embeddingOperation = _telemetryClient.StartOperation<DependencyTelemetry>("ProductDescription"))
                    {
                        embeddingOperation.Telemetry.Type = "OpenAI";
                        embeddingOperation.Telemetry.Target = "OpenAI";
                        embeddingOperation.Telemetry.Data = "EmbeddingGeneration";

                        try
                        {
                            var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(enrichedText);
                            embeddingVector = embeddingResponse.Value.ToFloats();
                            embeddingOperation.Telemetry.Success = true;
                        }
                        catch
                        {
                            embeddingOperation.Telemetry.Success = false;
                            throw;
                        }
                    }

                    // Store as float array for VECTOR column
                    var floatArray = embeddingVector.ToArray();

                    embeddings.Add(new ProductDescriptionEmbedding
                    {
                        ProductDescriptionID = description.ProductDescriptionID,
                        Embedding = floatArray,
                        ProductModelID = description.ProductModelID
                    });

                    _logger.LogInformation(
                        "Generated embedding for ProductDescriptionID {id}: {dimensions} dimensions",
                        description.ProductDescriptionID,
                        floatArray.Length
                    );
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Failed to generate embedding for ProductDescriptionID {id}",
                        description.ProductDescriptionID
                    );
                    throw;
                }
            }

            var totalDuration = DateTimeOffset.UtcNow - startTime;

            _telemetryClient.TrackEvent("EmbeddingsGenerated", new Dictionary<string, string>
            {
                ["Count"] = embeddings.Count.ToString(),
                ["DurationMs"] = totalDuration.TotalMilliseconds.ToString("F0")
            });

            _telemetryClient.TrackMetric("AI.Embeddings.AverageDurationMs",
                totalDuration.TotalMilliseconds / embeddings.Count);

            operation.Telemetry.Success = true;
            return embeddings;
        }
        catch (Exception ex)
        {
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex, new Dictionary<string, string>
            {
                ["Operation"] = "GenerateEmbeddings",
                ["DescriptionCount"] = descriptions.Count.ToString()
            });
            throw;
        }
    }

    public async Task<List<ProductNameEmbedding>> GenerateProductNameEmbeddingsAsync(List<ProductNameEmbeddingData> names)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

        var embeddings = new List<ProductNameEmbedding>();

        foreach (var item in names)
        {
            try
            {
                var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(item.Name);
                embeddings.Add(new ProductNameEmbedding
                {
                    ProductID = item.ProductID,
                    CultureID = item.CultureID,
                    Embedding = embeddingResponse.Value.ToFloats().ToArray()
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to generate embedding for ProductID={pid} CultureID={cid}", item.ProductID, item.CultureID);
            }
        }

        return embeddings;
    }

    /// <summary>
    /// Builds enriched text for embedding generation that includes product variants.
    /// This allows semantic search to match queries like "red bike" or "large helmet".
    /// </summary>
    private string BuildEnrichedTextForEmbedding(ProductDescriptionData description)
    {
        var parts = new List<string>();

        // Start with the main description
        parts.Add(description.Description);

        // Add category information if available
        if (!string.IsNullOrWhiteSpace(description.ProductCategoryName))
        {
            parts.Add($"Category: {description.ProductCategoryName}");
        }
        if (!string.IsNullOrWhiteSpace(description.ProductSubcategoryName))
        {
            parts.Add($"Type: {description.ProductSubcategoryName}");
        }

        // Add variant information - these are key for matching specific product attributes
        if (!string.IsNullOrWhiteSpace(description.Colors))
        {
            parts.Add($"Available colors: {description.Colors}");
        }
        if (!string.IsNullOrWhiteSpace(description.Sizes))
        {
            parts.Add($"Available sizes: {description.Sizes}");
        }
        if (!string.IsNullOrWhiteSpace(description.Styles))
        {
            parts.Add($"Styles: {description.Styles}");
        }
        if (!string.IsNullOrWhiteSpace(description.Classes))
        {
            parts.Add($"Quality class: {description.Classes}");
        }

        // Join all parts with newlines for better semantic understanding
        return string.Join("\n", parts);
    }

    public async Task<List<ProductReviewEmbedding>> GenerateReviewEmbeddingsAsync(List<ProductReviewData> reviews)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

        var embeddings = new List<ProductReviewEmbedding>();

        foreach (var review in reviews)
        {
            // Skip reviews without comments
            if (string.IsNullOrWhiteSpace(review.Comments))
            {
                _logger.LogWarning(
                    "Skipping ProductReviewID {id} - no comments to embed",
                    review.ProductReviewID
                );
                continue;
            }

            _logger.LogInformation(
                "Generating embedding for ProductReviewID {id} (ProductID: {productId}, Rating: {rating}, Length: {length} chars)",
                review.ProductReviewID,
                review.ProductID,
                review.Rating,
                review.Comments.Length
            );

            try
            {
                // Generate embedding for the review comments
                var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(review.Comments);
                var embeddingVector = embeddingResponse.Value.ToFloats();

                // Store as float array for VECTOR column
                var floatArray = embeddingVector.ToArray();

                embeddings.Add(new ProductReviewEmbedding
                {
                    ProductReviewID = review.ProductReviewID,
                    Embedding = floatArray,
                    ProductID = review.ProductID
                });

                _logger.LogInformation(
                    "Generated embedding for ProductReviewID {id}: {dimensions} dimensions",
                    review.ProductReviewID,
                    floatArray.Length
                );
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Failed to generate embedding for ProductReviewID {id}",
                    review.ProductReviewID
                );
                throw;
            }
        }

        return embeddings;
    }

    public async Task<float[]> GenerateQueryEmbeddingAsync(string queryText)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

        _logger.LogInformation(
            "Generating embedding for search query (Length: {length} chars)",
            queryText.Length
        );

        // Generate embedding for the query text
        var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(queryText);
        var embeddingVector = embeddingResponse.Value.ToFloats();

        // Return float array for VECTOR comparison
        var floatArray = embeddingVector.ToArray();

        _logger.LogInformation(
            "Generated query embedding: {dimensions} dimensions",
            floatArray.Length
        );

        return floatArray;
    }

    public async Task<List<ProductPhotoData>> GenerateProductImagesAsync(List<ProductImageData> products)
    {
        var credential = new DefaultAzureCredential();
        // gpt-image-1 generation can take 2-4 minutes per image.  The SDK default
        // NetworkTimeout is 100 s which is too short, causing AggregateException
        // "Retry failed after N tries" instead of a catchable 429.  Set a longer
        // per-request timeout so the SDK waits for the actual response.
        var imageClientOptions = new AzureOpenAIClientOptions();
        imageClientOptions.NetworkTimeout = TimeSpan.FromMinutes(8);
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential, imageClientOptions);
        var imageClient = client.GetImageClient(_imageDeploymentName);

        var photos = new List<ProductPhotoData>();

        foreach (var product in products)
        {
            // Determine target photo count: Universal style gets an extra image (male + female model)
            var isUniversal = product.Style?.Trim().ToUpperInvariant() == "U";
            var targetPhotoCount = isUniversal ? 5 : 4;

            // Only generate images if the product doesn't already have enough photos
            if (product.ExistingPhotoCount >= targetPhotoCount)
            {
                _logger.LogInformation(
                    "Skipping ProductID {productId} - already has {count} photos",
                    product.ProductID,
                    product.ExistingPhotoCount
                );
                continue;
            }

            var imagesToGenerate = targetPhotoCount - product.ExistingPhotoCount;
            _logger.LogInformation(
                "Generating {count} images for ProductID {productId} ({name})",
                imagesToGenerate,
                product.ProductID,
                product.Name
            );

            // Map single-char ProductLine code to full name
            var productLineLong = product.ProductLine?.Trim().ToUpperInvariant() switch
            {
                "R" => "Road",
                "M" => "Mountain",
                "T" => "Touring",
                "S" => "Standard",
                _ => null
            };

            // Map single-char Style code to gender description
            var styleCode = product.Style?.Trim().ToUpperInvariant();
            var genderLabel = styleCode switch
            {
                "M" => "men's",
                "W" => "women's",
                "U" => "unisex",
                _ => null
            };

            // Build rich base prompt from all available product attributes
            var promptParts = new List<string>
            {
                $"Professional product photography of {product.Name}"
            };

            if (!string.IsNullOrEmpty(product.Description))
                promptParts.Add(product.Description);

            if (!string.IsNullOrEmpty(product.ProductCategoryName))
                promptParts.Add($"Category: {product.ProductCategoryName}");

            if (!string.IsNullOrEmpty(product.ProductSubcategoryName))
                promptParts.Add($"Subcategory: {product.ProductSubcategoryName}");

            if (!string.IsNullOrEmpty(productLineLong))
                promptParts.Add($"Product line: {productLineLong}");

            if (!string.IsNullOrEmpty(product.Color))
                promptParts.Add($"The product colour is {product.Color.ToLower()}");

            if (genderLabel != null)
                promptParts.Add($"This is a {genderLabel} product");

            var basePrompt = string.Join(". ", promptParts) + ".";

            // Randomly select a model ethnicity for person-based shots for diversity
            var ethnicities = new[] { "Black", "East Asian", "South Asian", "Hispanic", "Middle Eastern", "White" };
            var rng = new Random(product.ProductID); // seed by ProductID so it's consistent per product
            var ethnicity = ethnicities[rng.Next(ethnicities.Length)];

            // Build perspective suffixes based on Style
            List<string> perspectives;
            if (isUniversal)
            {
                // Universal: 5 images — male model, female model, detail, flat-lay, lifestyle with both
                perspectives = new List<string>
                {
                    $" {ethnicity} male model wearing or using the product in an outdoor action shot, dynamic composition, natural lighting.",
                    $" {ethnicity} female model wearing or using the product in an outdoor action shot, dynamic composition, natural lighting.",
                    " Close-up detail shot highlighting product quality and features, studio lighting, white background.",
                    " Overhead flat-lay of the product on a natural textured surface such as weathered wood or slate rock, creative composition, soft natural lighting.",
                    $" Lifestyle shot in a natural outdoor environment featuring both a {ethnicity} male and female model together using the product."
                };
            }
            else
            {
                var modelAdjective = styleCode == "W" ? "Female" : styleCode == "M" ? "Male" : "Outdoor enthusiast";
                var modelGender = styleCode == "W" ? "female" : styleCode == "M" ? "male" : "outdoor enthusiast";
                perspectives = new List<string>
                {
                    $" {ethnicity} {modelAdjective.ToLower()} model wearing or using the product in an outdoor action shot, dynamic composition, natural lighting.",
                    " Close-up detail shot highlighting product quality and features, studio lighting, white background.",
                    " Overhead flat-lay of the product on a natural textured surface such as weathered wood or slate rock, creative composition, soft natural lighting.",
                    $" Lifestyle shot in a natural outdoor environment with a {ethnicity} {modelGender} model using the product in context."
                };
            }

            // Create prompts for each remaining perspective
            var prompts = new List<string>();
            for (int i = 0; i < imagesToGenerate; i++)
            {
                prompts.Add(basePrompt + perspectives[i]);
            }

            // Generate images
            for (int i = 0; i < prompts.Count; i++)
            {
                const int maxImageAttempts = 4;
                int attempt = 0;
                while (true)
                {
                    attempt++;
                    try
                    {
                        _logger.LogInformation(
                            "Generating image {index} for ProductID {productId} (attempt {attempt}): {prompt}",
                            i + 1,
                            product.ProductID,
                            attempt,
                            prompts[i].Substring(0, Math.Min(100, prompts[i].Length))
                        );

                        var imageOptions = new ImageGenerationOptions
                        {
                            Quality = "high",
                            Size = GeneratedImageSize.W1024xH1024
                            // ResponseFormat not supported by Azure OpenAI DALL-E models
                        };

                        var imageResult = await imageClient.GenerateImageAsync(prompts[i], imageOptions);
                        var imageBytes = imageResult.Value.ImageBytes.ToArray();

                        var photoNumber = product.ExistingPhotoCount + i + 1;
                        var fileName = $"product_{product.ProductID}_photo_{photoNumber}.png";

                        photos.Add(new ProductPhotoData
                        {
                            ProductID = product.ProductID,
                            ImageData = imageBytes,
                            FileName = fileName,
                            IsPrimary = photoNumber == 1 // First photo is primary
                        });

                        _logger.LogInformation(
                            "Generated image {index} for ProductID {productId}: {size} bytes, {fileName}",
                            i + 1,
                            product.ProductID,
                            imageBytes.Length,
                            fileName
                        );
                        break; // success — move to next image
                    }
                    catch (System.ClientModel.ClientResultException ex) when (ex.Status == 429 && attempt < maxImageAttempts)
                    {
                        // Rate-limited: wait with exponential back-off before retrying (30 s, 60 s, 90 s).
                        var delaySeconds = 30 * attempt;
                        _logger.LogWarning(
                            "Image {index} for ProductID {productId} hit rate limit (attempt {attempt}/{max}). " +
                            "Waiting {delay}s before retry.",
                            i + 1, product.ProductID, attempt, maxImageAttempts, delaySeconds);
                        await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
                    }
                    catch (AggregateException) when (attempt < maxImageAttempts)
                    {
                        // SDK exhausted its own internal retries (e.g. repeated timeouts).
                        // Wait before our next outer attempt.
                        var delaySeconds = 30 * attempt;
                        _logger.LogWarning(
                            "Image {index} for ProductID {productId} SDK retries exhausted (attempt {attempt}/{max}). " +
                            "Waiting {delay}s before retry.",
                            i + 1, product.ProductID, attempt, maxImageAttempts, delaySeconds);
                        await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(
                            ex,
                            "Failed to generate image {index} for ProductID {productId}",
                            i + 1,
                            product.ProductID
                        );
                        // Re-throw to let the queue mechanism handle the retry
                        throw;
                    }
                }
            }
        }

        return photos;
    }
}
