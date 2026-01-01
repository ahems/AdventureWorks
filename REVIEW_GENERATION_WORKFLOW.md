# Product Review Generation Workflow

## Overview

The product review generation system is a **"set it and forget it"** workflow that automatically generates AI-powered product reviews and their embeddings with a single API call.

## Architecture

The system uses **Azure Storage Queues** to process reviews asynchronously, similar to the product image generation workflow.

### Flow Diagram

```
HTTP POST /api/GenerateProductReviewsUsingAI_HttpStart
    ↓
[Queue Messages Created] (one per batch of 5 products)
    ↓
[Queue Trigger Processes Each Batch]
    ├─ Generate reviews with AI
    ├─ Save reviews to database
    └─ Check if last batch
         ↓
    [Auto-trigger Embedding Generation]
         ↓
    [Generate embeddings for all reviews]
```

## Components

### 1. HTTP Start Function

**Endpoint**: `POST /api/GenerateProductReviewsUsingAI_HttpStart`

- Fetches all finished goods products from database
- Creates queue messages (batches of 5 products)
- Clears any existing queue messages before starting
- Returns immediately after enqueuing

### 2. Queue Trigger Function

**Trigger**: `product-review-generation` queue

For each batch:

- Generates 0-10 reviews per product with AI
- Creates random review dates between product `SellStartDate` and now
- Saves reviews to database with random dates
- Monitors queue depth
- When last message is processed, automatically triggers embedding generation

### 3. Embedding Generation

**Auto-triggered**: When queue is empty

- Automatically starts embedding generation for all new reviews
- No manual intervention required

## Usage

### Single Command Setup

```bash
# Local development
curl -X POST http://localhost:7071/api/GenerateProductReviewsUsingAI_HttpStart

# Azure deployment
curl -X POST https://av-func-<unique>.azurecontainerapps.io/api/GenerateProductReviewsUsingAI_HttpStart
```

That's it! The system will:

1. ✅ Generate reviews for all products (batches of 5)
2. ✅ Save reviews with random historical dates
3. ✅ Automatically trigger embedding generation when complete
4. ✅ Generate embeddings for all reviews

## Configuration

### Environment Variables

- `SQL_CONNECTION_STRING` - Database connection
- `AZURE_OPENAI_ENDPOINT` - Azure OpenAI endpoint
- `EMBEDDING_GENERATION_ENDPOINT` - Auto-configured in Bicep (points to embedding function)
- `AzureWebJobsStorage__*` - Queue storage configuration

### Queue Settings

- **Queue Name**: `product-review-generation`
- **Batch Size**: 5 products per message
- **Poison Queue**: Automatic retry handling

## Monitoring

### Check Queue Status

```bash
# Azure CLI
az storage queue show --name product-review-generation --account-name <storage-account>
```

### View Logs

```bash
# Azure CLI
az containerapp logs show --name av-func-<unique> --resource-group <rg> --follow
```

### Application Insights

All operations are logged to Application Insights with correlation IDs for tracking:

- Review generation progress
- Batch processing status
- Embedding generation trigger
- Error tracking

## Benefits

### "Set It and Forget It"

- Single HTTP call starts entire workflow
- No need to monitor progress
- Automatic embedding generation
- Built-in error handling and retries

### Scalable

- Queue-based processing allows horizontal scaling
- Each batch processed independently
- Poison queue handles failures automatically

### Observable

- Comprehensive logging at each step
- Application Insights integration
- Queue metrics available in Azure Portal

## Review Data

### Generated Fields

Each review includes:

- `ProductID` - Product being reviewed
- `ReviewerName` - AI-generated reviewer name
- `EmailAddress` - Matching email address
- `Rating` - 1-5 stars based on sentiment
- `Comments` - Creative, entertaining review text
- `ReviewDate` - **Random date between product's SellStartDate and now**
- `ModifiedDate` - Set to current timestamp

### Review Date Generation

Reviews get realistic historical dates:

```csharp
// Calculate days between product availability and now
var daysBetween = (DateTime.UtcNow - product.SellStartDate).TotalDays;

// Generate random date in that range
var randomDays = random.Next(0, (int)daysBetween + 1);
review.ReviewDate = product.SellStartDate.AddDays(randomDays);
```

This creates a realistic distribution of reviews over the product's lifetime.

## Troubleshooting

### Queue Not Processing

1. Check queue exists: `az storage queue show`
2. Verify function app is running
3. Check Application Insights for errors

### Reviews Not Generated

1. Verify `AZURE_OPENAI_ENDPOINT` is set
2. Check managed identity has access to OpenAI
3. Review function logs for AI service errors

### Embeddings Not Triggered

1. Verify `EMBEDDING_GENERATION_ENDPOINT` environment variable
2. Check function app can make HTTP calls
3. Review logs for HTTP errors

### Need to Restart

Simply call the HTTP endpoint again - it clears existing queue messages and starts fresh.
