using Azure.AI.OpenAI;
using Azure.Identity;
using api_functions.Models;
using Microsoft.Extensions.Logging;
using OpenAI.Chat;
using OpenAI.Embeddings;
using OpenAI.Images;
using System.Text.Json;

namespace api_functions.Services;

// Helper class for JSON mode response
public class TranslationWrapper
{
    public List<TranslatedDescription>? Translations { get; set; }
}

public class AIService
{
    private readonly string _endpoint;
    private readonly string _deploymentName = "chat";
    private readonly string _embeddingDeploymentName = "embedding";
    private readonly string _imageDeploymentName = "gpt-image-1";
    private readonly ILogger<AIService> _logger;

    public AIService(string endpoint, ILogger<AIService> logger)
    {
        _endpoint = endpoint;
        _logger = logger;
    }

    public async Task<List<EnhancedProductData>> EnhanceProductsAsync(List<ProductData> products)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        var enhancedProducts = new List<EnhancedProductData>();

        // Process products in batches of 10 to avoid token limits
        const int batchSize = 10;
        for (int i = 0; i < products.Count; i += batchSize)
        {
            var batch = products.Skip(i).Take(batchSize).ToList();
            var batchResults = await ProcessBatchAsync(chatClient, batch);
            enhancedProducts.AddRange(batchResults);
        }

        return enhancedProducts;
    }

    private async Task<List<EnhancedProductData>> ProcessBatchAsync(ChatClient chatClient, List<ProductData> products)
    {
        var systemPrompt = @"You are a creative product description writer for an outdoor adventure equipment retailer called AdventureWorks.
Your task is to enhance product descriptions and fill in missing product data.

For each product, you must:
1. Create an enhanced, longer, more detailed product description based on the existing name, description, and category. Add fun, realistic feature descriptions like 'super shiny', 'extra-light', or 'go-faster stripes'. Be creative but realistic - no magical or fantasy features.
2. Fill in any missing data (Color, Size, Weight) with realistic values based on the product type. Use metric units (cm for size, kg for weight).

Return ONLY a valid JSON array with this exact structure for each product:
[
  {
    ""ProductID"": 123,
    ""ProductDescriptionID"": 456,
    ""EnhancedDescription"": ""enhanced description here"",
    ""Color"": ""Red"",
    ""Size"": ""42"",
    ""SizeUnitMeasureCode"": ""CM"",
    ""Weight"": 2.5,
    ""WeightUnitMeasureCode"": ""KG""
  }
]

Important constraints:
- Weight must be a number, not a string
- Size maximum length: 5 characters
- If a value already exists in the input, keep it. Only fill in missing (null) values.";

        var productJson = JsonSerializer.Serialize(products.Select(p => new
        {
            p.ProductID,
            p.ProductDescriptionID,
            p.Name,
            p.Description,
            p.ProductCategoryName,
            p.ProductSubcategoryName,
            p.Color,
            p.Size,
            p.SizeUnitMeasureCode,
            p.Weight,
            p.WeightUnitMeasureCode,
            p.Class,
            p.Style
        }), new JsonSerializerOptions { WriteIndented = true });

        var userPrompt = $"Here are the products to enhance:\n\n{productJson}\n\nReturn the enhanced data as a JSON array.";

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemPrompt),
            new UserChatMessage(userPrompt)
        };

        var response = await chatClient.CompleteChatAsync(messages, new ChatCompletionOptions
        {
            Temperature = 0.7f,
            MaxOutputTokenCount = 4000
        });

        var content = response.Value.Content[0].Text;

        // Extract JSON from response (may be wrapped in markdown code blocks)
        var jsonStart = content.IndexOf('[');
        var jsonEnd = content.LastIndexOf(']') + 1;
        var json = content.Substring(jsonStart, jsonEnd - jsonStart);

        var enhancedProducts = JsonSerializer.Deserialize<List<EnhancedProductData>>(json);

        // Log the description lengths
        if (enhancedProducts != null)
        {
            foreach (var product in enhancedProducts)
            {
                _logger.LogInformation(
                    "Product {ProductID}: Enhanced description length = {Length} characters",
                    product.ProductID,
                    product.EnhancedDescription?.Length ?? 0
                );
            }
        }

        return enhancedProducts ?? new List<EnhancedProductData>();
    }

    public async Task<List<TranslatedDescription>> TranslateProductAsync(
        TranslationRequest request,
        List<CultureInfo> targetCultures)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        return await TranslateProductAsync(chatClient, request, targetCultures);
    }

    public async Task<List<TranslatedDescription>> TranslateDescriptionsAsync(
        List<TranslationRequest> requests,
        List<CultureInfo> targetCultures)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        var translations = new List<TranslatedDescription>();

        // Process each product's description
        foreach (var request in requests)
        {
            var productTranslations = await TranslateProductAsync(
                chatClient,
                request,
                targetCultures);
            translations.AddRange(productTranslations);
        }

        return translations;
    }

    private async Task<List<TranslatedDescription>> TranslateProductAsync(
        ChatClient chatClient,
        TranslationRequest request,
        List<CultureInfo> targetCultures)
    {
        var systemPrompt = @"You are a professional translator for an outdoor adventure equipment retailer called AdventureWorks.
Your task is to translate product descriptions into multiple languages while maintaining the technical accuracy, style, and marketing appeal of the original text.

Important guidelines:
1. Preserve all product specifications and technical details accurately
2. Maintain the enthusiastic, marketing-focused tone
3. Keep brand names and product names in English (e.g., 'HL Road Frame', 'Sport-100 Helmet')
4. Use culturally appropriate expressions while staying true to the original message
5. Ensure translations are natural and idiomatic in the target language

Return ONLY a valid JSON object with this exact structure:
{
  ""translations"": [
    {
      ""CultureID"": ""fr"",
      ""CultureName"": ""French"",
      ""TranslatedText"": ""translated description here""
    }
  ]
}";

        var culturesJson = JsonSerializer.Serialize(targetCultures.Select(c => new
        {
            CultureID = c.CultureID.Trim(),
            CultureName = c.Name
        }), new JsonSerializerOptions { WriteIndented = true });

        var userPrompt = $@"Product: {request.ProductName}

English Description:
{request.EnglishDescription}

Target Languages:
{culturesJson}

Translate the description into each target language. Return ONLY a valid JSON object with a 'translations' array containing all translations.";

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemPrompt),
            new UserChatMessage(userPrompt)
        };

        var response = await chatClient.CompleteChatAsync(messages, new ChatCompletionOptions
        {
            Temperature = 0.3f, // Lower temperature for more consistent translations
            MaxOutputTokenCount = 16000, // Maximum for very long descriptions in 6 languages
            ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat() // Ensure valid JSON output
        });

        var content = response.Value.Content[0].Text;

        // Log the raw response for debugging
        _logger.LogInformation("AI response for product {ProductModelID}: {ResponseLength} chars",
            request.ProductModelID, content?.Length ?? 0);

        if (string.IsNullOrWhiteSpace(content))
        {
            _logger.LogError("Empty response from AI for product {ProductModelID}", request.ProductModelID);
            return new List<TranslatedDescription>();
        }

        // Log first 1000 chars of AI response for debugging
        _logger.LogInformation("AI response preview for product {ProductModelID}: {Preview}",
            request.ProductModelID, content.Length > 1000 ? content.Substring(0, 1000) + "..." : content);

        // With JSON mode, the entire response should be valid JSON
        List<TranslatedDescription>? translatedDescriptions;
        try
        {
            _logger.LogInformation("Attempting to deserialize JSON for product {ProductModelID}", request.ProductModelID);

            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            };
            var wrapper = JsonSerializer.Deserialize<TranslationWrapper>(content, options);

            _logger.LogInformation("Wrapper deserialized for product {ProductModelID}: wrapper={Wrapper}, translations={Count}",
                request.ProductModelID, wrapper != null ? "not null" : "NULL", wrapper?.Translations?.Count ?? -1);

            translatedDescriptions = wrapper?.Translations;

            if (translatedDescriptions == null || translatedDescriptions.Count == 0)
            {
                _logger.LogWarning("Deserialization succeeded but returned null or empty for product {ProductModelID}", request.ProductModelID);
            }
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Failed to parse JSON for product {ProductModelID}. Response: {Json}",
                request.ProductModelID, content.Length > 500 ? content.Substring(0, 500) + "..." : content);
            return new List<TranslatedDescription>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error parsing response for product {ProductModelID}", request.ProductModelID);
            return new List<TranslatedDescription>();
        }

        if (translatedDescriptions != null)
        {
            foreach (var translation in translatedDescriptions)
            {
                translation.ProductModelID = request.ProductModelID;
                _logger.LogInformation(
                    "Translated product {ProductModelID} to {Culture}: {Length} characters",
                    request.ProductModelID,
                    translation.CultureName,
                    translation.TranslatedText?.Length ?? 0
                );
            }
        }

        return translatedDescriptions ?? new List<TranslatedDescription>();
    }

    public async Task<List<ProductDescriptionEmbedding>> GenerateEmbeddingsAsync(List<ProductDescriptionData> descriptions)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

        var embeddings = new List<ProductDescriptionEmbedding>();

        foreach (var description in descriptions)
        {
            _logger.LogInformation(
                "Generating embedding for ProductDescriptionID {id} (Culture: {culture}, Length: {length} chars)",
                description.ProductDescriptionID,
                description.CultureID,
                description.Description.Length
            );

            try
            {
                // Generate embedding for the description text
                var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(description.Description);
                var embeddingVector = embeddingResponse.Value.ToFloats();

                // Convert ReadOnlyMemory<float> to byte array for VARBINARY storage
                var floatArray = embeddingVector.ToArray();
                var embeddingBytes = new byte[floatArray.Length * sizeof(float)];
                Buffer.BlockCopy(floatArray, 0, embeddingBytes, 0, embeddingBytes.Length);

                embeddings.Add(new ProductDescriptionEmbedding
                {
                    ProductDescriptionID = description.ProductDescriptionID,
                    Embedding = embeddingBytes,
                    ProductModelID = description.ProductModelID
                });

                _logger.LogInformation(
                    "Generated embedding for ProductDescriptionID {id}: {dimensions} dimensions, {bytes} bytes",
                    description.ProductDescriptionID,
                    floatArray.Length,
                    embeddingBytes.Length
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

        return embeddings;
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

                // Convert ReadOnlyMemory<float> to byte array for VARBINARY storage
                var floatArray = embeddingVector.ToArray();
                var embeddingBytes = new byte[floatArray.Length * sizeof(float)];
                Buffer.BlockCopy(floatArray, 0, embeddingBytes, 0, embeddingBytes.Length);

                embeddings.Add(new ProductReviewEmbedding
                {
                    ProductReviewID = review.ProductReviewID,
                    Embedding = embeddingBytes,
                    ProductID = review.ProductID
                });

                _logger.LogInformation(
                    "Generated embedding for ProductReviewID {id}: {dimensions} dimensions, {bytes} bytes",
                    review.ProductReviewID,
                    floatArray.Length,
                    embeddingBytes.Length
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

    public async Task<byte[]> GenerateQueryEmbeddingAsync(string queryText)
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

        // Convert ReadOnlyMemory<float> to byte array for VARBINARY comparison
        var floatArray = embeddingVector.ToArray();
        var embeddingBytes = new byte[floatArray.Length * sizeof(float)];
        Buffer.BlockCopy(floatArray, 0, embeddingBytes, 0, embeddingBytes.Length);

        _logger.LogInformation(
            "Generated query embedding: {dimensions} dimensions, {bytes} bytes",
            floatArray.Length,
            embeddingBytes.Length
        );

        return embeddingBytes;
    }

    public async Task<List<GeneratedReview>> GenerateProductReviewsAsync(List<ProductForReviewGeneration> products)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        var allReviews = new List<GeneratedReview>();

        // Process each product individually for better control
        foreach (var product in products)
        {
            var reviews = await GenerateReviewsForProductAsync(chatClient, product);
            allReviews.AddRange(reviews);
        }

        return allReviews;
    }

    private async Task<List<GeneratedReview>> GenerateReviewsForProductAsync(ChatClient chatClient, ProductForReviewGeneration product)
    {
        var random = new Random();

        // Generate between 0 and 10 reviews per product
        var reviewCount = random.Next(0, 11);

        if (reviewCount == 0)
        {
            _logger.LogInformation("Skipping reviews for ProductID {ProductID} (randomly selected 0 reviews)", product.ProductID);
            return new List<GeneratedReview>();
        }

        // Randomly select review sentiment ratio (1=positive, 2=mixed, 3=negative)
        var sentimentRatio = random.Next(1, 4);
        var sentimentDescription = sentimentRatio switch
        {
            1 => "mostly positive (4-5 stars), with some 3-star mixed reviews",
            2 => "evenly mixed between positive (4-5 stars) and negative (1-2 stars), with some 3-star reviews",
            3 => "mostly negative (1-2 stars), with some 3-star mixed reviews",
            _ => "mixed"
        };

        _logger.LogInformation(
            "Generating {count} {sentiment} reviews for ProductID {ProductID}: {name}",
            reviewCount,
            sentimentDescription,
            product.ProductID,
            product.Name
        );

        var systemPrompt = @"You are a creative review generator for AdventureWorks, an outdoor adventure equipment retailer.
Your task is to generate fun, amusing, and realistic product reviews that match the playful tone of the demo site.

Generate reviews that:
1. Match the specified sentiment ratio (positive/mixed/negative)
2. Reference specific product features from the description
3. Include funny, creative reasons people might love or hate the product
4. Sound like real customer reviews with personality
5. Use varied reviewer names (some names can appear multiple times across different products)
6. Include realistic email addresses matching the names
7. Have appropriate ratings (1-5 stars) matching the sentiment
8. Vary in length and detail (some short, some longer)

Return ONLY a valid JSON array with this exact structure:
[
  {
    ""ReviewerName"": ""John Smith"",
    ""EmailAddress"": ""john.smith@email.com"",
    ""Rating"": 5,
    ""Comments"": ""Absolutely love this product! The extra-shiny coating makes me feel like a superhero...""
  }
]

Make the reviews entertaining while keeping them realistic. Be creative with the commentary!";

        var productJson = JsonSerializer.Serialize(new
        {
            product.ProductID,
            product.Name,
            product.Description
        }, new JsonSerializerOptions { WriteIndented = true });

        var userPrompt = $@"Generate {reviewCount} reviews for this product with {sentimentDescription}:

{productJson}

Return the reviews as a JSON array.";

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemPrompt),
            new UserChatMessage(userPrompt)
        };

        try
        {
            var response = await chatClient.CompleteChatAsync(messages, new ChatCompletionOptions
            {
                Temperature = 0.9f, // Higher temperature for more creative/varied reviews
                MaxOutputTokenCount = 4000
            });

            var content = response.Value.Content[0].Text;

            // Extract JSON from response (may be wrapped in markdown code blocks)
            var jsonStart = content.IndexOf('[');
            var jsonEnd = content.LastIndexOf(']') + 1;

            if (jsonStart == -1 || jsonEnd <= jsonStart)
            {
                _logger.LogWarning("No valid JSON array found in response for ProductID {ProductID}", product.ProductID);
                return new List<GeneratedReview>();
            }

            var json = content.Substring(jsonStart, jsonEnd - jsonStart);
            var generatedReviews = JsonSerializer.Deserialize<List<GeneratedReview>>(json);

            if (generatedReviews != null)
            {
                // Calculate date range for random review dates
                var sellStartDate = product.SellStartDate;
                var currentDate = DateTime.UtcNow;
                var daysBetween = (currentDate - sellStartDate).TotalDays;

                // Set the ProductID and random ReviewDate for all reviews
                foreach (var review in generatedReviews)
                {
                    review.ProductID = product.ProductID;

                    // Generate random date between product sell start and now
                    var randomDays = random.Next(0, (int)daysBetween + 1);
                    review.ReviewDate = sellStartDate.AddDays(randomDays);
                }

                _logger.LogInformation(
                    "Generated {count} reviews for ProductID {ProductID}",
                    generatedReviews.Count,
                    product.ProductID
                );

                return generatedReviews;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Failed to generate reviews for ProductID {ProductID}",
                product.ProductID
            );
        }

        return new List<GeneratedReview>();
    }

    public async Task<List<ProductPhotoData>> GenerateProductImagesAsync(List<ProductImageData> products)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var imageClient = client.GetImageClient(_imageDeploymentName);

        var photos = new List<ProductPhotoData>();

        foreach (var product in products)
        {
            // Only generate images if the product doesn't already have 4 or more photos
            if (product.ExistingPhotoCount >= 4)
            {
                _logger.LogInformation(
                    "Skipping ProductID {productId} - already has {count} photos",
                    product.ProductID,
                    product.ExistingPhotoCount
                );
                continue;
            }

            var imagesToGenerate = 4 - product.ExistingPhotoCount;
            _logger.LogInformation(
                "Generating {count} images for ProductID {productId} ({name})",
                imagesToGenerate,
                product.ProductID,
                product.Name
            );

            // Create prompts for different perspectives
            var prompts = new List<string>();
            var basePrompt = $"Professional product photography of {product.Name}";

            if (!string.IsNullOrEmpty(product.Description))
            {
                basePrompt += $". {product.Description}";
            }

            if (!string.IsNullOrEmpty(product.ProductCategoryName))
            {
                basePrompt += $" Category: {product.ProductCategoryName}.";
            }

            var perspectives = new[]
            {
                " Product in use by an outdoor enthusiast, action shot, dynamic composition.",
                " Close-up detail shot showing product features and quality, studio lighting.",
                " Three-quarter view on white background, professional e-commerce style.",
                " Lifestyle shot in natural outdoor environment, contextual setting."
            };

            for (int i = 0; i < imagesToGenerate; i++)
            {
                prompts.Add(basePrompt + perspectives[i]);
            }

            // Generate images
            for (int i = 0; i < prompts.Count; i++)
            {
                try
                {
                    _logger.LogInformation(
                        "Generating image {index} for ProductID {productId}: {prompt}",
                        i + 1,
                        product.ProductID,
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
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Failed to generate image {index} for ProductID {productId}",
                        i + 1,
                        product.ProductID
                    );
                    // Re-throw to halt the entire orchestration
                    throw;
                }
            }
        }

        return photos;
    }

    public async Task<JsonElement> TranslateLanguageFileAsync(
        JsonElement languageData,
        string languageCode,
        string languageName)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        // Get region-specific email suffix and example cities
        var regionalInfo = GetRegionalInfo(languageCode);

        // Check if this is an English regional variant
        var isEnglishVariant = languageCode.ToLowerInvariant().StartsWith("en-");

        var systemPrompt = isEnglishVariant
            ? $@"You are a professional localizer for the AdventureWorks e-commerce demo application.
You are adapting a language file (i18n JSON) from American English to {languageName}.

CRITICAL INSTRUCTIONS:
1. Adapt ALL values for {languageName} while maintaining the fun, adventurous vibe
2. Keep ALL keys exactly as they are - ONLY modify the values
3. Preserve the JSON structure perfectly, including nested objects and arrays
4. Keep HTML tags, placeholders like {{{{count}}}}, {{{{percent}}}}, {{{{name}}}}, etc. exactly as they appear
5. Apply regional spelling conventions (e.g., 'colour' vs 'color', 'favourite' vs 'favorite')
6. Use regional vocabulary and phrases where appropriate (e.g., 'post code' vs 'zip code', 'lorry' vs 'truck')
7. For email addresses:
   - Use regional names common in {languageName}-speaking regions
   - Use regional email suffix: {regionalInfo.EmailSuffix}
   - Example: '{regionalInfo.EmailExample}'
8. For street addresses and cities:
   - Use realistic city names: {string.Join(", ", regionalInfo.ExampleCities)}
   - Adapt street address format to regional conventions
   - Keep fun, creative street names but make them sound natural for the region
9. Adapt idioms and expressions to sound natural in {languageName}
10. Preserve all special characters, punctuation, and formatting
11. Keep the enthusiastic, friendly, marketing tone
12. Return ONLY valid JSON - the exact same structure as input but with adapted values

Regional context: You are localizing for {languageName} customers, so ensure the language sounds natural and familiar to them while maintaining the outdoor adventure theme.

IMPORTANT: Return ONLY the complete localized JSON object. Do not wrap it in markdown code blocks or add any explanatory text."
            : $@"You are a professional translator for the AdventureWorks e-commerce demo application.
You are translating a language file (i18n JSON) from English to {languageName}.

CRITICAL INSTRUCTIONS:
1. Translate ALL values while maintaining the fun, adventurous vibe of the original English text
2. Keep ALL keys exactly as they are in the original - ONLY translate the values
3. Preserve the JSON structure perfectly, including nested objects and arrays
4. Keep HTML tags, placeholders like {{{{count}}}}, {{{{percent}}}}, {{{{name}}}}, etc. exactly as they appear
5. Keep technical terms like 'GraphQL', 'API', brand names, and product codes in English
6. For email addresses (like example emails): 
   - Use common regional names appropriate for {languageName}
   - Use regional email suffix: {regionalInfo.EmailSuffix}
   - Example: instead of 'your@email.com' use something like '{regionalInfo.EmailExample}'
7. For street addresses and cities:
   - Create fun, made-up street addresses appropriate for {languageName}-speaking regions
   - Use realistic city names for {languageName}-speaking countries
   - Examples of cities to use: {string.Join(", ", regionalInfo.ExampleCities)}
   - Make street names fun and creative (like 'Adventure Lane' → fun equivalent in {languageName})
8. Preserve all special characters, punctuation, and formatting
9. Keep the enthusiastic, friendly, marketing tone
10. Return ONLY valid JSON - the exact same structure as input but with translated values

Regional context: You are translating for {languageName}-speaking customers, so ensure cultural appropriateness while maintaining the outdoor adventure theme.

IMPORTANT: Return ONLY the complete translated JSON object. Do not wrap it in markdown code blocks or add any explanatory text.";

        var userPrompt = $@"Here is the English language file to translate to {languageName}:

{JsonSerializer.Serialize(languageData, new JsonSerializerOptions { WriteIndented = true })}

Return the complete translated version with all values translated to {languageName}, keeping all keys in English.";

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemPrompt),
            new UserChatMessage(userPrompt)
        };

        _logger.LogInformation("Sending translation request for {Language}", languageName);

        var response = await chatClient.CompleteChatAsync(messages, new ChatCompletionOptions
        {
            Temperature = 0.7f, // Moderate creativity for natural translations with fun vibe
            MaxOutputTokenCount = 16000,
            ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat() // Ensure valid JSON
        });

        var content = response.Value.Content[0].Text;

        _logger.LogInformation("Received translation response for {Language}: {Length} characters",
            languageName, content?.Length ?? 0);

        if (string.IsNullOrWhiteSpace(content))
        {
            throw new InvalidOperationException($"Empty response from AI for {languageName} translation");
        }

        // Parse the JSON response
        try
        {
            var translatedJson = JsonSerializer.Deserialize<JsonElement>(content);
            return translatedJson;
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Failed to parse AI translation response for {Language}", languageName);
            _logger.LogError("Response content: {Content}", content.Length > 2000 ? content.Substring(0, 2000) + "..." : content);
            throw new InvalidOperationException($"AI returned invalid JSON for {languageName} translation", ex);
        }
    }

    public async Task<string> TranslateTextAsync(
        string text,
        string languageCode,
        string languageName)
    {
        var credential = new DefaultAzureCredential();
        var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
        var chatClient = client.GetChatClient(_deploymentName);

        // Get region-specific information
        var regionalInfo = GetRegionalInfo(languageCode);

        // Check if this is an English regional variant
        var isEnglishVariant = languageCode.ToLowerInvariant().StartsWith("en-");

        var systemPrompt = isEnglishVariant
            ? $@"You are a professional localizer adapting text from American English to {languageName}.

CRITICAL INSTRUCTIONS:
1. Apply regional spelling conventions (e.g., 'colour' vs 'color', 'favourite' vs 'favorite')
2. Use regional vocabulary and phrases where appropriate
3. Preserve HTML tags, placeholders like {{{{count}}}}, {{{{percent}}}}, {{{{name}}}}, etc. exactly as they appear
4. Maintain the tone and style of the original text
5. Keep technical terms, brand names, and product codes in English
6. For email addresses: use regional suffix {regionalInfo.EmailSuffix}
7. For cities/locations: use realistic names from {string.Join(", ", regionalInfo.ExampleCities)}
8. Return ONLY the adapted text, nothing else"
            : $@"You are a professional translator translating from English to {languageName}.

CRITICAL INSTRUCTIONS:
1. Translate the text naturally while maintaining its original tone and intent
2. Preserve HTML tags, placeholders like {{{{count}}}}, {{{{percent}}}}, {{{{name}}}}, etc. exactly as they appear
3. Keep technical terms, brand names, and product codes in English
4. For email addresses: use regional suffix {regionalInfo.EmailSuffix}
5. For cities/locations: use realistic names from {string.Join(", ", regionalInfo.ExampleCities)}
6. Ensure cultural appropriateness for {languageName}-speaking audiences
7. Return ONLY the translated text, nothing else";

        var userPrompt = $"Text to {(isEnglishVariant ? "adapt" : "translate")}:\n\n{text}";

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(systemPrompt),
            new UserChatMessage(userPrompt)
        };

        var response = await chatClient.CompleteChatAsync(messages, new ChatCompletionOptions
        {
            Temperature = 0.3f, // Lower temperature for more consistent translations
            MaxOutputTokenCount = 1000
        });

        var translatedText = response.Value.Content[0].Text?.Trim() ?? text;

        if (string.IsNullOrWhiteSpace(translatedText))
        {
            _logger.LogWarning("Empty translation response for text: {Text}", text);
            return text; // Return original if translation fails
        }

        return translatedText;
    }

    private RegionalInfo GetRegionalInfo(string languageCode)
    {
        return languageCode.ToLowerInvariant() switch
        {
            "es" => new RegionalInfo
            {
                EmailSuffix = ".es",
                EmailExample = "juan@email.es",
                ExampleCities = new[] { "Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao" }
            },
            "fr" => new RegionalInfo
            {
                EmailSuffix = ".fr",
                EmailExample = "marie@email.fr",
                ExampleCities = new[] { "Paris", "Lyon", "Marseille", "Toulouse", "Nice" }
            },
            "de" => new RegionalInfo
            {
                EmailSuffix = ".de",
                EmailExample = "hans@email.de",
                ExampleCities = new[] { "Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne" }
            },
            "pt" => new RegionalInfo
            {
                EmailSuffix = ".pt",
                EmailExample = "joao@email.pt",
                ExampleCities = new[] { "Lisbon", "Porto", "Braga", "Coimbra", "Faro" }
            },
            "it" => new RegionalInfo
            {
                EmailSuffix = ".it",
                EmailExample = "marco@email.it",
                ExampleCities = new[] { "Rome", "Milan", "Naples", "Turin", "Florence" }
            },
            "nl" => new RegionalInfo
            {
                EmailSuffix = ".nl",
                EmailExample = "jan@email.nl",
                ExampleCities = new[] { "Amsterdam", "Rotterdam", "Utrecht", "The Hague", "Eindhoven" }
            },
            "ru" => new RegionalInfo
            {
                EmailSuffix = ".ru",
                EmailExample = "ivan@email.ru",
                ExampleCities = new[] { "Moscow", "Saint Petersburg", "Novosibirsk", "Yekaterinburg", "Kazan" }
            },
            "zh" => new RegionalInfo
            {
                EmailSuffix = ".cn",
                EmailExample = "wei@email.cn",
                ExampleCities = new[] { "Beijing", "Shanghai", "Guangzhou", "Shenzhen", "Chengdu" }
            },
            "zh-cht" => new RegionalInfo
            {
                EmailSuffix = ".tw",
                EmailExample = "chen@email.tw",
                ExampleCities = new[] { "Taipei", "Kaohsiung", "Taichung", "Tainan", "Hsinchu" }
            },
            "ja" => new RegionalInfo
            {
                EmailSuffix = ".jp",
                EmailExample = "tanaka@email.jp",
                ExampleCities = new[] { "Tokyo", "Osaka", "Kyoto", "Yokohama", "Sapporo" }
            },
            "ko" => new RegionalInfo
            {
                EmailSuffix = ".kr",
                EmailExample = "kim@email.kr",
                ExampleCities = new[] { "Seoul", "Busan", "Incheon", "Daegu", "Daejeon" }
            },
            "ar" => new RegionalInfo
            {
                EmailSuffix = ".sa",
                EmailExample = "ahmed@email.sa",
                ExampleCities = new[] { "Riyadh", "Dubai", "Cairo", "Jeddah", "Abu Dhabi" }
            },
            "he" => new RegionalInfo
            {
                EmailSuffix = ".il",
                EmailExample = "david@email.il",
                ExampleCities = new[] { "Tel Aviv", "Jerusalem", "Haifa", "Rishon LeZion", "Petah Tikva" }
            },
            "tr" => new RegionalInfo
            {
                EmailSuffix = ".tr",
                EmailExample = "mehmet@email.tr",
                ExampleCities = new[] { "Istanbul", "Ankara", "Izmir", "Bursa", "Antalya" }
            },
            "vi" => new RegionalInfo
            {
                EmailSuffix = ".vn",
                EmailExample = "nguyen@email.vn",
                ExampleCities = new[] { "Hanoi", "Ho Chi Minh City", "Da Nang", "Hai Phong", "Can Tho" }
            },
            "th" => new RegionalInfo
            {
                EmailSuffix = ".th",
                EmailExample = "somchai@email.th",
                ExampleCities = new[] { "Bangkok", "Chiang Mai", "Phuket", "Pattaya", "Krabi" }
            },
            "id" => new RegionalInfo
            {
                EmailSuffix = ".id",
                EmailExample = "budi@email.id",
                ExampleCities = new[] { "Jakarta", "Surabaya", "Bandung", "Bali", "Yogyakarta" }
            },
            "en-gb" => new RegionalInfo
            {
                EmailSuffix = ".co.uk",
                EmailExample = "james@email.co.uk",
                ExampleCities = new[] { "London", "Manchester", "Edinburgh", "Birmingham", "Liverpool" }
            },
            "en-ca" => new RegionalInfo
            {
                EmailSuffix = ".ca",
                EmailExample = "sarah@email.ca",
                ExampleCities = new[] { "Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa" }
            },
            "en-au" => new RegionalInfo
            {
                EmailSuffix = ".com.au",
                EmailExample = "jack@email.com.au",
                ExampleCities = new[] { "Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide" }
            },
            "en-nz" => new RegionalInfo
            {
                EmailSuffix = ".co.nz",
                EmailExample = "emma@email.co.nz",
                ExampleCities = new[] { "Auckland", "Wellington", "Christchurch", "Hamilton", "Dunedin" }
            },
            "en-ie" => new RegionalInfo
            {
                EmailSuffix = ".ie",
                EmailExample = "sean@email.ie",
                ExampleCities = new[] { "Dublin", "Cork", "Galway", "Limerick", "Waterford" }
            },
            _ => new RegionalInfo
            {
                EmailSuffix = ".com",
                EmailExample = "user@email.com",
                ExampleCities = new[] { "New York", "Los Angeles", "Chicago", "Houston", "Phoenix" }
            }
        };
    }
}

public class RegionalInfo
{
    public string EmailSuffix { get; set; } = ".com";
    public string EmailExample { get; set; } = "user@email.com";
    public string[] ExampleCities { get; set; } = Array.Empty<string>();
}
