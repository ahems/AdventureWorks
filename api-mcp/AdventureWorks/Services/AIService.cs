using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.Logging;
using OpenAI.Embeddings;

namespace AdventureWorks.Services;

public class AIService
{
    private readonly string _endpoint;
    private readonly string _embeddingDeploymentName = "embedding";
    private readonly ILogger<AIService> _logger;

    public AIService(string endpoint, ILogger<AIService> logger)
    {
        _endpoint = endpoint;
        _logger = logger;
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
}
