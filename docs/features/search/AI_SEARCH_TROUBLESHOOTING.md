# AI Search with Embeddings - Troubleshooting Guide

## Issue Summary

AI search tests are failing because the semantic search API endpoint (`/api/search/semantic`) returns HTTP 500 errors. The database contains valid embedding vectors, but the Azure Functions app fails when attempting to generate query embeddings via Azure OpenAI.

## Investigation Results

### ✅ What's Working

1. **Database has embeddings**:
   - ProductDescription.DescriptionEmbedding contains valid 1536-dimension VECTOR data
   - Verified via DAB API: `curl https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/ProductDescription`

2. **SQL queries are correct**:
   - ProductService uses `VECTOR_DISTANCE('cosine', pd.DescriptionEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))`
   - ReviewService uses `VECTOR_DISTANCE('cosine', pr.CommentsEmbedding, CAST(@QueryEmbedding AS VECTOR(1536)))`

3. **Configuration is correct**:
   - `AZURE_OPENAI_ENDPOINT` is set: `https://av-openai-72b9397c.cognitiveservices.azure.com/`
   - `API_FUNCTIONS_URL` is configured in both API and frontend
   - DefaultAzureCredential is properly configured with Managed Identity support

### ❌ What's Broken

1. **Semantic search endpoint returns 500**:

   ```bash
   curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/search/semantic" \
     -H "Content-Type: application/json" \
     -d '{"query":"bike","topN":5}'
   # Returns: HTTP/2 500
   ```

2. **Test failures**:
   ```
   tests/specs/ai-features.spec.ts:51:29
   Error: expect(received).toBeGreaterThan(expected)
   Expected: > 0
   Received:   0
   ```

### ⚠️ Additional Observations

- ProductReview table is empty (0 records) - review search will return no results but shouldn't cause a 500 error
- The function hangs for ~10 seconds before returning 500, suggesting network timeout or authentication failure

## Root Cause Analysis

The most likely causes (in order of probability):

### 1. Azure OpenAI Deployment Name Mismatch

**File**: `api-functions/Services/AIService.cs` (line 23)

```csharp
private readonly string _embeddingDeploymentName = "embedding";
```

This hardcoded name must match the actual deployment name in Azure OpenAI. If the deployment is named differently (e.g., `text-embedding-ada-002`, `embedding-ada-002`), the API call will fail.

**How to verify**:

```bash
azd env get-values | grep -i embedding
# Look for embeddingDeploymentModelName or similar
```

### 2. Managed Identity Permissions

The Functions app's Managed Identity may not have `Cognitive Services OpenAI User` role on the Azure OpenAI resource.

**How to verify**:

```bash
# Get the Functions app's Managed Identity
FUNC_IDENTITY=$(az containerapp show --name av-func-ewphuc52etkbc --resource-group rg-adamhems-adventureworks --query identity.principalId -o tsv)

# Check role assignments on OpenAI resource
az role assignment list --assignee $FUNC_IDENTITY --all
```

### 3. Azure OpenAI Rate Limiting

If the embedding model has low quota or is being throttled, requests may fail.

**How to verify**: Check Azure OpenAI resource metrics in Azure Portal for throttling/429 errors

### 4. Network/Timeout Issues

The 10-second delay before 500 error suggests potential network issues between Container Apps and Azure OpenAI.

## Recommended Fixes

### Fix 1: Verify and Configure Embedding Deployment Name

**Action**: Check the actual embedding deployment name and update configuration

```bash
# Get the embedding deployment name from environment
azd env get-values | grep -i embedding

# Or check in Azure Portal:
# Azure OpenAI resource > Model deployments > look for text-embedding model
```

Then update one of these locations:

**Option A**: Use environment variable (recommended)

```csharp
// In AIService.cs constructor
private readonly string _embeddingDeploymentName;

public AIService(string endpoint, string embeddingDeploymentName, ...)
{
    _embeddingDeploymentName = embeddingDeploymentName ?? "embedding";
}

// In Program.cs
builder.Services.AddScoped<AIService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var endpoint = configuration["AZURE_OPENAI_ENDPOINT"];
    var embeddingDeployment = configuration["AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] ?? "embedding";
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    return new AIService(endpoint, embeddingDeployment, logger, telemetryClient);
});
```

**Option B**: Update hardcoded value if deployment is named differently

```csharp
private readonly string _embeddingDeploymentName = "text-embedding-ada-002"; // or actual name
```

### Fix 2: Grant Managed Identity Permissions

```bash
# Get resource names
RESOURCE_GROUP=$(azd env get-value AZURE_RESOURCE_GROUP)
FUNC_NAME="av-func-ewphuc52etkbc"
OPENAI_NAME="av-openai-72b9397c"

# Get Managed Identity principal ID
FUNC_IDENTITY=$(az containerapp show \
  --name $FUNC_NAME \
  --resource-group $RESOURCE_GROUP \
  --query identity.principalId -o tsv)

# Get OpenAI resource ID
OPENAI_ID=$(az cognitiveservices account show \
  --name $OPENAI_NAME \
  --resource-group $RESOURCE_GROUP \
  --query id -o tsv)

# Assign role
az role assignment create \
  --assignee $FUNC_IDENTITY \
  --role "Cognitive Services OpenAI User" \
  --scope $OPENAI_ID
```

### Fix 3: Add Better Error Handling and Logging

Update `SemanticSearchFunction.cs` to capture the actual error:

```csharp
catch (Exception ex)
{
    _logger.LogError(ex, "Error performing semantic search: {ErrorMessage}", ex.Message);

    // Log inner exception details
    if (ex.InnerException != null)
    {
        _logger.LogError("Inner exception: {InnerMessage}", ex.InnerException.Message);
    }

    var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
    await errorResponse.WriteAsJsonAsync(new {
        error = "An error occurred while performing the search",
        details = ex.Message // Include in dev/staging only
    });
    return errorResponse;
}
```

### Fix 4: Add Retry Logic for OpenAI Calls

Update `AIService.GenerateQueryEmbeddingAsync()` to handle transient failures:

```csharp
public async Task<float[]> GenerateQueryEmbeddingAsync(string queryText, int maxRetries = 3)
{
    var credential = new DefaultAzureCredential();
    var client = new AzureOpenAIClient(new Uri(_endpoint), credential);
    var embeddingClient = client.GetEmbeddingClient(_embeddingDeploymentName);

    for (int attempt = 1; attempt <= maxRetries; attempt++)
    {
        try
        {
            _logger.LogInformation(
                "Generating embedding for search query (Length: {length} chars, Attempt: {attempt})",
                queryText.Length,
                attempt
            );

            var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(queryText);
            var floatArray = embeddingResponse.Value.ToFloats().ToArray();

            _logger.LogInformation(
                "Generated query embedding: {dimensions} dimensions",
                floatArray.Length
            );

            return floatArray;
        }
        catch (Exception ex) when (attempt < maxRetries)
        {
            _logger.LogWarning(ex,
                "Failed to generate embedding (attempt {attempt}/{maxRetries}): {message}",
                attempt, maxRetries, ex.Message
            );
            await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt))); // Exponential backoff
        }
    }

    throw new InvalidOperationException($"Failed to generate embedding after {maxRetries} attempts");
}
```

## Testing the Fix

After applying fixes, test with:

```bash
# Test semantic search directly
curl -X POST "https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query":"bike for mountain trails","topN":5}'

# Should return JSON with results:
# {
#   "query": "bike for mountain trails",
#   "results": [...],
#   "totalResults": 5,
#   "descriptionMatches": 5,
#   "reviewMatches": 0
# }
```

Then run the Playwright test:

```bash
npx playwright test ai-features -g "AI search with embeddings"
```

## Next Steps

1. **Immediate**: Verify embedding deployment name and update if needed
2. **Quick**: Check and grant Managed Identity permissions to Azure OpenAI
3. **Important**: Add better error logging to capture actual error messages
4. **Nice to have**: Add retry logic for transient failures
5. **Generate reviews**: Run `./generate-reviews-with-embeddings.sh` to populate ProductReview table with embeddings for complete semantic search coverage

## Related Files

- `api-functions/Services/AIService.cs` - AI service with embedding generation
- `api-functions/Services/ProductService.cs` - Product embedding search (line 439+)
- `api-functions/Services/ReviewService.cs` - Review embedding search (line 120+)
- `api-functions/Functions/SemanticSearchFunction.cs` - HTTP endpoint
- `app/src/hooks/useSemanticSearch.ts` - Frontend hook
- `app/src/pages/SearchPage.tsx` - Search UI
- `tests/specs/ai-features.spec.ts` - Test that's failing
