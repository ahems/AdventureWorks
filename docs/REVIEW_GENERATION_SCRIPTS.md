# Review Generation Scripts - Usage Guide

This guide explains how to use the AI-powered review generation scripts with both local and Azure-deployed functions.

## Scripts Available

### 1. `generate-reviews.sh`

Generates AI-powered product reviews only (0-10 per product with varied sentiment).

### 2. `generate-reviews-with-embeddings.sh` (Recommended)

Complete workflow that generates reviews AND creates embeddings for searchability.

## Usage

Both scripts automatically detect whether to use local or Azure-deployed functions:

### Using Azure Deployment (Automatic)

If you've deployed with `azd deploy`, the scripts will automatically use the Azure Functions URL:

```bash
./generate-reviews-with-embeddings.sh
```

Output will show:

```
✨ Using deployed Azure Functions
Using Functions endpoint: https://av-func-xxxxx.azurecontainerapps.io
```

### Using Local Functions

If no Azure deployment is found, scripts default to local:

```bash
# Terminal 1: Start local functions
cd api-functions
func start

# Terminal 2: Run script
./generate-reviews-with-embeddings.sh
```

Output will show:

```
⚠️  Using local endpoint
Using Functions endpoint: http://localhost:7071
```

### Manual Override

Force a specific endpoint with the `FUNCTIONS_URL` environment variable:

```bash
# Use specific Azure deployment
FUNCTIONS_URL="https://my-functions.azurecontainerapps.io" ./generate-reviews-with-embeddings.sh

# Force local
FUNCTIONS_URL="http://localhost:7071" ./generate-reviews-with-embeddings.sh
```

## Troubleshooting

### Script fails immediately

**Check if functions are deployed:**

```bash
azd env get-values | grep API_FUNCTIONS_URL
```

Should return something like:

```
API_FUNCTIONS_URL="https://av-func-xxxxx.azurecontainerapps.io"
```

If empty, deploy functions:

```bash
azd deploy api-functions
```

### HTTP 500 errors

**Check Azure Functions logs:**

```bash
# Get resource group and function name
RESOURCE_GROUP=$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d '=' -f2 | tr -d '"')
FUNC_NAME=$(azd env get-values | grep SERVICE_API_FUNCTIONS_NAME | cut -d '=' -f2 | tr -d '"')

# View logs
az containerapp logs show \
  --name $FUNC_NAME \
  --resource-group $RESOURCE_GROUP \
  --tail 100 \
  --follow false
```

**Common issues:**

- Missing environment variables (SQL_CONNECTION_STRING, AZURE_OPENAI_ENDPOINT)
- Database connectivity issues
- Azure OpenAI quota exceeded

### Test individual functions

**Test review generation:**

```bash
API_URL=$(azd env get-values | grep API_FUNCTIONS_URL | cut -d '=' -f2 | tr -d '"')
curl -X POST "$API_URL/api/GenerateProductReviewsUsingAI_HttpStart"
```

**Test embedding generation:**

```bash
curl -X POST "$API_URL/api/GenerateProductReviewEmbeddings_HttpStart"
```

Both should return JSON with `statusQueryGetUri` field.

### Check function status

After triggering, check status with the returned URL:

```bash
# Get status URL from trigger response
STATUS_URL="<statusQueryGetUri from response>"
curl $STATUS_URL
```

Response will include:

- `"runtimeStatus"`: "Running", "Completed", or "Failed"
- `"output"`: Final result when completed

## Expected Execution Time

- **Review Generation**: 30-60 minutes (depends on product count)
- **Embedding Generation**: 10-20 minutes (depends on review count)
- **Complete Workflow**: 40-80 minutes total

## What Gets Created

Running the complete workflow creates:

1. **Product Reviews**

   - 0-10 reviews per product (random)
   - Varied sentiment (positive/mixed/negative)
   - Creative, fun commentary
   - Stored in `Production.ProductReview`

2. **Review Embeddings**

   - 1536-dimension vectors
   - Enables semantic search
   - Stored in `CommentsEmbedding` column

3. **Typical Output**
   - ~1,500-2,000 reviews for ~300 products
   - Fully searchable with vector similarity

## Running During Development

### First-time setup

```bash
# 1. Deploy database schema changes
azd deploy

# 2. Generate reviews and embeddings
./generate-reviews-with-embeddings.sh
```

### Subsequent runs

```bash
# Delete existing reviews first if regenerating
# (This removes ALL reviews - use with caution)
az sql db query \
  --server <server-name> \
  --database AdventureWorks \
  --name "DELETE FROM Production.ProductReview WHERE ProductReviewID > 0" \
  --auth-type ActiveDirectoryDefault

# Then generate new reviews
./generate-reviews-with-embeddings.sh
```

## Monitoring Progress

The scripts show real-time progress:

```
🚀 Starting: Review Generation
✅ Started successfully
📊 Processing...
.......
✅ Review Generation completed!
   Successfully generated and saved 1847 reviews across 294 products
```

## Next Steps

After successful generation:

1. Reviews appear on product detail pages
2. Review search functionality is enabled
3. Embeddings power "similar reviews" features
4. Demo site is ready to showcase

## Support

If issues persist:

1. Check Azure portal for function app errors
2. Verify database connectivity
3. Ensure Azure OpenAI deployment is active
4. Check Application Insights for detailed telemetry
