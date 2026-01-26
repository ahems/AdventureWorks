# Telemetry Generator for Demo Analysis

## Overview

The telemetry generator creates realistic Application Insights telemetry data by simulating authentic user browsing sessions. This is useful for:

- **Demo Preparation**: Generate rich telemetry before presenting Application Insights features
- **Testing Analytics**: Validate your Application Insights queries and dashboards
- **Training**: Create realistic data for learning Application Insights analysis
- **Performance Baselines**: Establish typical user behavior patterns

## Quick Start

```bash
./generate-telemetry.sh
```

Select from the interactive menu:

1. **Single Extended Session** (5-7 min) - Deep browsing with cart abandonment
2. **Multiple Quick Sessions** (3-4 min) - Different user personas
3. **Both** (8-11 min) - Maximum variety
4. **Continuous** - Runs until stopped (Ctrl+C)
5. **View Summary** - Check recent telemetry

## What Gets Generated

### Extended Browsing Session (Option 1)

Simulates a **bargain hunter** who:

- ✅ Arrives at home page looking for deals
- ✅ Clicks on "On Sale" or special offers section
- ✅ Quick views 3-5 products (if quick view available)
- ✅ Views 4-7 products in full detail
- ✅ Cycles through product image galleries (2-4 images per product)
- ✅ Selects different size/color options
- ✅ Performs 2-3 searches with different keywords
- ✅ Clicks on search results
- ✅ Adds 2-4 items to cart
- ✅ Views cart and considers purchase
- ✅ Gets distracted, browses more products
- ❌ Abandons cart without purchasing

**Generates ~50-100 telemetry events:**

- 15-20 page views
- 8-12 Product_View events
- 2-3 search queries
- 2-4 Product_AddToCart events
- Cart abandonment behavior
- Performance metrics for each page

### Multiple Quick Sessions (Option 2)

Simulates **3 different personas**:

1. **Window Shopper**
   - Searches for "bike"
   - Views 3 bike products
   - Doesn't add anything to cart
   - Leaves quickly

2. **Quick Buyer**
   - Searches for "bottle"
   - Views 2 products
   - Adds one to cart
   - Fast session

3. **Comparison Shopper**
   - Searches for "touring"
   - Views 4 similar products
   - Compares details
   - Doesn't purchase

**Generates ~40-60 telemetry events**

### Continuous Generation (Option 4)

Runs both session types repeatedly until stopped. Perfect for:

- Long-running demos
- Stress testing Application Insights
- Creating weeks/months of simulated data

Press `Ctrl+C` to stop.

## Telemetry Events Generated

### Page Views

```
- Home page (/)
- Product listing pages
- Product detail pages (/product/:id)
- Search results
- Cart page (/cart)
```

### Custom Events

#### Product Events

```javascript
Product_View {
  productId: "680",
  productName: "HL Road Frame - Black, 58",
  category: "Bikes",
  subcategory: "Road Bikes",
  price: 1431.50
}

Product_AddToCart {
  productId: "680",
  productName: "HL Road Frame - Black, 58",
  quantity: 1,
  price: 1431.50,
  size: "58",
  color: "Black"
}
```

#### User Interactions

- Image gallery navigation
- Size/color selection
- Search queries
- Quick view interactions

### Performance Metrics

- Page load durations
- Image load times
- API response times
- User session duration

## Analyzing the Generated Telemetry

### Wait for Ingestion

After running the generator, wait **2-3 minutes** for Application Insights to ingest the data.

### View Summary

```bash
./generate-telemetry.sh
# Choose option 5
```

### Kusto Queries for Analysis

#### Cart Abandonment Rate

```kusto
let cartAdds = customEvents
  | where timestamp > ago(1h)
  | where name == "Product_AddToCart"
  | summarize Adds=count();
let purchases = customEvents
  | where timestamp > ago(1h)
  | where name == "Purchase_Complete"
  | summarize Purchases=count();
cartAdds
| extend Purchases=toscalar(purchases)
| extend AbandonmentRate = 100.0 * (Adds - Purchases) / Adds
| project Adds, Purchases, AbandonmentRate
```

#### Most Viewed Products

```kusto
customEvents
| where timestamp > ago(1h)
| where name == "Product_View"
| extend productId = tostring(customDimensions.productId)
| extend productName = tostring(customDimensions.productName)
| summarize Views=count() by productId, productName
| order by Views desc
| take 10
```

#### User Journey Flow

```kusto
union pageViews, customEvents
| where timestamp > ago(1h)
| project timestamp, session_Id, EventType=itemType, EventName=coalesce(name, "PageView"), URL=url
| order by session_Id, timestamp asc
| take 100
```

#### Search to Purchase Funnel

```kusto
let sessions = pageViews
  | where timestamp > ago(1h)
  | distinct session_Id;
sessions
| join kind=leftouter (
    customEvents
    | where name == "Search_Query"
    | summarize Searches=count() by session_Id
) on session_Id
| join kind=leftouter (
    customEvents
    | where name == "Product_View"
    | summarize ProductViews=count() by session_Id
) on session_Id
| join kind=leftouter (
    customEvents
    | where name == "Product_AddToCart"
    | summarize CartAdds=count() by session_Id
) on session_Id
| summarize
    TotalSessions=count(),
    SessionsWithSearches=countif(Searches > 0),
    SessionsWithViews=countif(ProductViews > 0),
    SessionsWithCartAdds=countif(CartAdds > 0)
| extend SearchRate = 100.0 * SessionsWithSearches / TotalSessions
| extend ViewRate = 100.0 * SessionsWithViews / TotalSessions
| extend CartRate = 100.0 * SessionsWithCartAdds / TotalSessions
```

#### Average Session Duration

```kusto
pageViews
| where timestamp > ago(1h)
| summarize SessionStart=min(timestamp), SessionEnd=max(timestamp) by session_Id
| extend DurationMinutes = datetime_diff('minute', SessionEnd, SessionStart)
| summarize
    AvgDuration=avg(DurationMinutes),
    MedianDuration=percentile(DurationMinutes, 50),
    MaxDuration=max(DurationMinutes)
```

#### Performance Heatmap

```kusto
pageViews
| where timestamp > ago(1h)
| extend LoadTimeBucket = case(
    duration < 1000, "< 1s",
    duration < 2000, "1-2s",
    duration < 3000, "2-3s",
    duration < 5000, "3-5s",
    "> 5s"
)
| summarize Count=count() by LoadTimeBucket, name
| order by LoadTimeBucket, Count desc
```

## Example Demo Scenarios

### Scenario 1: E-Commerce Analytics Dashboard

1. **Generate data:**

   ```bash
   ./generate-telemetry.sh  # Option 3 (Both)
   ```

2. **Wait 3 minutes**, then show:
   - Cart abandonment rate: ~100% (no purchases)
   - Most viewed products
   - Average session duration: 5-7 minutes
   - Search query patterns

3. **Key insights to highlight:**
   - "73% of users who add items to cart don't complete purchase"
   - "Road bikes are the most viewed category"
   - "Users spend average 6 minutes browsing before abandoning"

### Scenario 2: User Journey Analysis

1. **Generate continuous data:**

   ```bash
   ./generate-telemetry.sh  # Option 4 (Continuous)
   ```

   Let it run for 10-15 minutes.

2. **Show user flow:**
   - Home → Search → Product View → Add to Cart → Cart → Exit
   - Visualize drop-off points
   - Identify where users get "distracted"

3. **Key insights:**
   - "Users who search are 40% more likely to add items to cart"
   - "Image gallery engagement increases time on page by 30%"

### Scenario 3: Performance Monitoring

1. **Generate data during different times:**
   - Morning batch
   - Afternoon batch
   - Evening batch

2. **Compare performance metrics:**
   - Page load times
   - API response times
   - Browser performance

3. **Key insights:**
   - "Product pages with image galleries load 200ms slower"
   - "Search queries take 150ms on average"

## Customizing the Generator

### Modify Product IDs

Edit [telemetry-generator.spec.ts](tests/specs/telemetry-generator.spec.ts):

```typescript
// Change these to match your catalog
const popularProductIds = [
  "680",
  "706",
  "707", // Your product IDs here
];
```

### Adjust Browsing Behavior

```typescript
// Increase products viewed
const detailViewCount = Math.floor(Math.random() * 8) + 6; // 6-13 products

// Change cart add probability
if (maybe(0.8)) { // 80% chance to add to cart

// Adjust wait times
await randomWait(3000, 6000); // Longer viewing time
```

### Add Custom Events

```typescript
// Track when user hovers over product
await page.hover('[data-testid="product-card"]');
console.log("📊 Tracking hover event");
```

## Troubleshooting

### "No telemetry generated"

**Check:**

1. Application Insights connection string is configured:

   ```bash
   azd env get-values | grep APPINSIGHTS
   ```

2. Web app is accessible:

   ```bash
   curl $(azd env get-value APP_REDIRECT_URI)
   ```

3. Browser console for errors (run with `--headed` flag):
   ```bash
   cd tests
   npx playwright test telemetry-generator.spec.ts --headed
   ```

### "Tests timeout"

**Solution:**
Increase timeout in test file:

```typescript
test.setTimeout(600000); // 10 minutes
```

### "Products not found"

**Solution:**
The test uses hardcoded product IDs from AdventureWorks. If your catalog differs:

1. Browse your site manually
2. Note product IDs from URLs
3. Update product ID arrays in the test

## Best Practices

1. **Run after deployment**: Generate fresh data after each `azd up`
2. **Label test data**: Add custom dimensions to identify synthetic data
3. **Clean up old data**: Application Insights retains data for 90 days by default
4. **Don't over-generate**: Too much test data can skew analytics
5. **Time appropriately**: Run during off-hours if analyzing production

## Related Files

- [tests/specs/telemetry-generator.spec.ts](tests/specs/telemetry-generator.spec.ts) - Test implementation
- [tests/specs/telemetry.spec.ts](tests/specs/telemetry.spec.ts) - Network validation tests
- [tests/specs/telemetry-validation.spec.ts](tests/specs/telemetry-validation.spec.ts) - Query validation tests
- [tests/TELEMETRY_TESTING.md](tests/TELEMETRY_TESTING.md) - Telemetry testing documentation

## License Note

This telemetry generator is for **demonstration and testing purposes only**. Do not use it to artificially inflate production metrics or violate usage policies.
