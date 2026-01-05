# Product Embedding Enhancement - Variant Information Integration

## Issue

Semantic search was not returning accurate results for queries that included variant-specific attributes (e.g., "red bikes", "large helmet", "women's jacket"). This was because product embeddings only included the `ProductDescription` text, which typically doesn't mention specific colors, sizes, or styles.

## Solution

Enhanced the embedding generation process to include product variant information alongside the description text. Now embeddings include:

- **Product Description** - The original description text
- **Category** - Product category (e.g., "Bikes")
- **Type** - Product subcategory (e.g., "Mountain Bikes")
- **Available Colors** - All color variants (e.g., "Red, Blue, Black")
- **Available Sizes** - All size variants (e.g., "Small, Medium, Large")
- **Styles** - Style variants (e.g., "Women's, Men's, Unisex")
- **Quality Classes** - Quality classes (e.g., "High, Medium, Low")

## Changes Made

### 1. Updated Data Model

**File**: `api-functions/Models/ProductData.cs`

Added new fields to `ProductDescriptionData`:

```csharp
public string? ProductNames { get; set; }
public string? Colors { get; set; }
public string? Sizes { get; set; }
public string? Styles { get; set; }
public string? Classes { get; set; }
public string? ProductCategoryName { get; set; }
public string? ProductSubcategoryName { get; set; }
```

### 2. Enhanced SQL Query

**File**: `api-functions/Services/ProductService.cs`

Updated `GetProductDescriptionsForEmbeddingAsync()` to:

- Join with `Product` table to get variant information
- Use `STRING_AGG` to combine all variants for a product model
- Include category and subcategory information

```sql
SELECT
    pd.ProductDescriptionID,
    pd.Description,
    pmx.CultureID,
    pmx.ProductModelID,
    STRING_AGG(DISTINCT p.Color, ', ') AS Colors,
    STRING_AGG(DISTINCT p.Size, ', ') AS Sizes,
    ...
FROM Production.ProductDescription pd
INNER JOIN Production.Product p ON p.ProductModelID = pmx.ProductModelID
...
```

### 3. Enriched Embedding Text

**File**: `api-functions/Services/AIService.cs`

Added `BuildEnrichedTextForEmbedding()` method that combines description with variant information:

```csharp
private string BuildEnrichedTextForEmbedding(ProductDescriptionData description)
{
    var parts = new List<string>();
    parts.Add(description.Description);

    if (!string.IsNullOrWhiteSpace(description.Colors))
        parts.Add($"Available colors: {description.Colors}");

    if (!string.IsNullOrWhiteSpace(description.Sizes))
        parts.Add($"Available sizes: {description.Sizes}");

    // ... more variants

    return string.Join("\n", parts);
}
```

## Regenerating Embeddings

To apply these changes to existing products, you need to regenerate all product embeddings:

### Step 1: Clear Existing Embeddings

Run this SQL script to reset embeddings (this allows the function to process them again):

```sql
UPDATE Production.ProductDescription
SET DescriptionEmbedding = NULL,
    ModifiedDate = GETDATE();
```

### Step 2: Trigger Embedding Generation

There are two ways to regenerate embeddings:

#### Option A: Via HTTP Endpoint (Recommended)

```bash
# Get the function URL
FUNCTION_URL=$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '"')

# Trigger embedding generation
curl -X POST "$FUNCTION_URL/api/GenerateProductEmbeddings_HttpStart"
```

#### Option B: Via Local Function

```bash
# Start functions locally
cd api-functions
func start

# In another terminal, trigger the function
curl -X POST "http://localhost:7071/api/GenerateProductEmbeddings_HttpStart"
```

### Step 3: Monitor Progress

The function will process products in batches of 10 and provide status updates. You can check the status using the orchestration status endpoint returned in the response.

### Step 4: Verify Results

Query to check how many embeddings have been generated:

```sql
SELECT
    COUNT(*) as TotalDescriptions,
    SUM(CASE WHEN DescriptionEmbedding IS NOT NULL THEN 1 ELSE 0 END) as WithEmbeddings,
    SUM(CASE WHEN DescriptionEmbedding IS NULL THEN 1 ELSE 0 END) as WithoutEmbeddings
FROM Production.ProductDescription pd
INNER JOIN Production.ProductModelProductDescriptionCulture pmx
    ON pd.ProductDescriptionID = pmx.ProductDescriptionID;
```

## Impact on Semantic Search

After regenerating embeddings, semantic search queries will now match:

### Before (Description Only)

- ❌ "red bikes" → Only matched if description mentioned "red"
- ❌ "large helmet" → Only matched if description mentioned "large"
- ❌ "women's jacket" → Only matched if description mentioned "women's"

### After (With Variants)

- ✅ "red bikes" → Matches all bikes that have red as a color variant
- ✅ "large helmet" → Matches all helmets available in large size
- ✅ "women's jacket" → Matches all jackets with women's style
- ✅ "high quality mountain bike" → Matches bikes with "High" class
- ✅ "small black shirt" → Matches shirts that are both small and black

## Example Enriched Embedding Text

**Before**:

```
The Mountain-200 bike features a lightweight aluminum frame and
front suspension for comfortable rides on rough terrain.
```

**After**:

```
The Mountain-200 bike features a lightweight aluminum frame and
front suspension for comfortable rides on rough terrain.
Category: Bikes
Type: Mountain Bikes
Available colors: Black, Red, Silver
Available sizes: 38, 42, 46
Styles: Unisex
Quality class: High
```

## Testing

### Test Query 1: Color-Based Search

```bash
curl -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "red bikes", "topN": 5}'
```

Expected: Should return bikes that have red as an available color.

### Test Query 2: Size-Based Search

```bash
curl -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "large helmet", "topN": 5}'
```

Expected: Should return helmets available in large size.

### Test Query 3: Combined Attributes

```bash
curl -X POST "$FUNCTION_URL/api/search/semantic" \
  -H "Content-Type: application/json" \
  -d '{"query": "black mountain bike for women", "topN": 5}'
```

Expected: Should return mountain bikes that are black and have women's style.

## Performance Considerations

- **Embedding Size**: Still 1536 dimensions (no change)
- **Storage Impact**: No additional database storage required
- **Query Performance**: No change to query performance
- **Generation Time**: Slightly increased per embedding due to longer text, but still within acceptable limits
- **Batch Processing**: Maintains batch size of 10 for optimal throughput

## Future Enhancements

Consider adding to embeddings:

1. **Price Range** - "Budget", "Mid-range", "Premium"
2. **Weight** - For products where weight matters
3. **Product Numbers** - For exact SKU matching
4. **Review Sentiment** - "Highly rated", "Customer favorite"

## Troubleshooting

### Embeddings Not Generating

- Check Azure OpenAI service is accessible
- Verify `AZURE_OPENAI_ENDPOINT` environment variable is set
- Check function logs for detailed error messages

### Search Still Not Working

- Ensure embeddings have been regenerated after deploying this change
- Verify embeddings exist: `SELECT TOP 10 * FROM Production.ProductDescription WHERE DescriptionEmbedding IS NOT NULL`
- Test with multiple queries to isolate the issue

### Partial Results

- Check if embedding generation completed for all products
- Some products may have failed - check function logs
- Re-run the generation function for failed batches

## Related Files

- `api-functions/Functions/GenerateProductEmbeddings.cs` - Orchestration logic
- `api-functions/Services/AIService.cs` - Embedding generation
- `api-functions/Services/ProductService.cs` - Data retrieval
- `api-functions/Models/ProductData.cs` - Data models
- `api-functions/Functions/SemanticSearchFunction.cs` - Search endpoint
