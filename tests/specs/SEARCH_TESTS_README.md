# Search Functionality Tests

## Overview

This test suite validates the search functionality of the AdventureWorks e-commerce application. The tests focus on ensuring accurate search results without requiring user authentication.

## Test Cases

### 1. Search for Red Helmets

**Test**: `search for red helmets returns only red helmet products`

- Searches for "red helmet"
- Verifies all results contain "helmet" in the product name
- Handles cases where no matching products exist

### 2. Search for Red Frames

**Test**: `search for red frames returns only frame products in red`

- Uses URL query parameter: `/search?q=red frame`
- Verifies all results contain "frame" in the product name
- Validates color filtering works correctly

### 3. Search for Bikes

**Test**: `search for bikes returns bike-related products`

- Searches for "bike"
- Verifies results contain "bike" in the product name
- Handles cases where semantic search may not return results

### 4. Color Filter Search

**Test**: `search for specific color filters results correctly`

- Tests color-based filtering by searching for "red"
- Verifies search filtering is active
- Compares filtered vs unfiltered result counts

### 5. Empty Search

**Test**: `empty search shows all products`

- Tests search page behavior without a query
- Validates page loads correctly even without search terms

### 6. No Results Handling

**Test**: `search handles no results gracefully`

- Searches for nonsense query: "xyznonexistentproduct12345"
- Verifies appropriate messaging for empty results

### 7. Sort Functionality

**Test**: `search results can be sorted`

- Tests presence of sort controls
- Validates sort order can be changed
- Checks different sort options (price, rating, etc.)

### 8. URL Query Parameters

**Test**: `search with URL query parameter works`

- Uses direct URL: `/search?q=helmet`
- Verifies search input is populated from URL
- Validates results are loaded automatically

## Technical Details

### Test Selectors

The tests use precise data-testid selectors for reliability:

- `[data-testid^="product-card-"]` - Product cards
- `[data-testid^="product-name-"]` - Product names
- `input[placeholder*="Search"]` - Search input field
- `button[type="submit"]` with text "Search" - Submit button

### Timing & Waits

- **Initial page load**: 5-6 seconds to allow for cold starts
- **Search execution**: 5 seconds after submitting search
- **Service warmup**: Tests warm up DAB API and Web App before running

### Known Limitations

1. **Semantic Search Dependency**: The search functionality uses AI-powered semantic search with embeddings. If the embeddings aren't indexed or the AI service is unavailable, searches may return zero results.

2. **Color Verification**: Tests cannot reliably verify product color from the UI alone, as colors may be displayed in various ways (text, badges, variant selectors). Color filtering is validated at the API level.

3. **Pagination**: The DAB API returns a maximum of 100 items per query. Tests account for this limitation.

4. **Product Availability**: Tests handle cases where products may be out of stock or not available in certain color/size combinations.

## Troubleshooting

### No Results Returned

If searches return zero results:

1. **Check Semantic Search Service**: Verify the AI service is running and embeddings are indexed

   ```bash
   azd env get-values | grep -E "(AI_AGENT|AZURE_OPENAI)"
   ```

2. **Verify API Connectivity**: Test the GraphQL API directly

   ```bash
   curl -X POST "${API_URL}" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ products { items { ProductID Name Color } } }"}'
   ```

3. **Check Product Data**: Verify products exist in the database
   ```bash
   API_URL=$(azd env get-values | grep VITE_API_URL | cut -d'=' -f2 | tr -d '"')
   curl -X POST "$API_URL" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ products(filter: { Name: { contains: \"Bike\" } }) { items { Name Color } } }"}'
   ```

### Slow Test Execution

- Tests include generous timeouts (5-6 seconds) to handle Azure cold starts
- Container Apps may take additional time to wake up
- Consider running tests after warming up services manually

### Element Not Found Errors

- Verify the search page is accessible at `/search`
- Check that products are loading (may require API to be operational)
- Ensure data-testid attributes are present in ProductCard components

## Running the Tests

```bash
# Run all search tests
cd tests
npx playwright test search.spec.ts

# Run with UI
npx playwright test search.spec.ts --ui

# Run specific test
npx playwright test search.spec.ts -g "red helmets"

# Run with debugging
npx playwright test search.spec.ts --debug
```

## Environment Requirements

- `WEB_BASE_URL` or `APP_REDIRECT_URI` - Frontend URL
- `REST_API_BASE_URL` or `VITE_API_URL` - GraphQL API endpoint
- `FUNCTIONS_BASE_URL` or `VITE_API_FUNCTIONS_URL` - Azure Functions endpoint

These are automatically retrieved from `azd env` if not set in environment.

## Future Enhancements

1. **Add tests for faceted filtering** - Test category, price range, and other filters
2. **Pagination tests** - Validate next/previous page navigation
3. **Sort order validation** - Verify products are actually sorted correctly
4. **Multi-criteria search** - Test complex queries like "red mountain bike under $500"
5. **Search suggestions** - Test autocomplete/suggestions if implemented
6. **Performance metrics** - Track search response times
