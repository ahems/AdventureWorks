using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Extensions.Logging;
using OpenAI.Embeddings;

namespace AdventureWorks.Services;

public class AIService
{
    private readonly string _endpoint;
    private readonly string _embeddingDeploymentName = "embedding";
    private readonly ILogger<AIService> _logger;
    private readonly TelemetryClient _telemetryClient;

    public AIService(string endpoint, ILogger<AIService> logger, TelemetryClient telemetryClient)
    {
        _endpoint = endpoint;
        _logger = logger;
        _telemetryClient = telemetryClient;
    }

    public async Task<float[]> GenerateQueryEmbeddingAsync(string queryText)
    {
        using var operation = _telemetryClient.StartOperation<DependencyTelemetry>("Generate Query Embedding");
        operation.Telemetry.Type = "OpenAI";
        operation.Telemetry.Data = $"Embedding for query (length: {queryText.Length})";

        try
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

            operation.Telemetry.Properties["dimensions"] = floatArray.Length.ToString();
            operation.Telemetry.Properties["queryLength"] = queryText.Length.ToString();
            operation.Telemetry.Success = true;

            return floatArray;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating query embedding");
            operation.Telemetry.Success = false;
            _telemetryClient.TrackException(ex);
            throw;
        }
    }
}
