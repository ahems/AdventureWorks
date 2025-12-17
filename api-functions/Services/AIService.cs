using Azure.AI.OpenAI;
using Azure.Identity;
using api_functions.Models;
using Microsoft.Extensions.Logging;
using OpenAI.Chat;
using OpenAI.Embeddings;
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
}
