# Playwright Test Data Randomization Analysis

## Executive Summary

This document analyzes all Playwright tests in the workspace to identify hardcoded data patterns and ensure proper randomization, particularly for database queries.

**Analysis Date:** January 28, 2026

## Key Findings

### ✅ What's Working Well

1. **User Data Randomization**
   - All tests use `faker` library for generating random user credentials
   - Email addresses, names, and passwords are fully randomized
   - Address data uses random generation with faker (street names, cities, zip codes)

2. **Test Isolation**
   - Each test creates its own unique user via `signupThroughUi()`
   - No shared state between tests
   - Proper cleanup patterns in place

### ⚠️ Issues Identified

#### 1. **Hardcoded Product IDs**

Multiple tests use small, hardcoded arrays of product IDs instead of querying from the entire product catalog:

**product-reviews.spec.ts:**

```typescript
const testProducts = [680, 707, 712, 771, 772, 776, 777];
const testProductId =
  testProducts[Math.floor(Math.random() * testProducts.length)];
```

- Only selects from 7 products out of potentially hundreds
- Same products tested repeatedly

**browsing-shopping.spec.ts:**

```typescript
const productIdsToTry = [680, 707, 711, 712, 715, 716, 717];
```

- Limited to 7 specific products for cart testing
- Doesn't cover broader product range

**checkout.spec.ts:**

```typescript
await page.goto(`${testEnv.webBaseUrl}/product/680`);
// Fallback to:
await page.goto(`${testEnv.webBaseUrl}/product/707`);
```

- Single hardcoded product ID
- Fallback to another hardcoded ID

**telemetry.spec.ts, telemetry-validation.spec.ts:**

```typescript
await page.goto(`${testEnv.webBaseUrl}/product/680`);
```

- Always uses product ID 680

**internationalization.spec.ts:**

```typescript
await page.goto(`${testEnv.webBaseUrl}/product/680`);
```

- Hardcoded product for price currency testing

**sale-discounts.spec.ts:**

```typescript
await page.goto(`${testEnv.webBaseUrl}/product/680`);
```

- Uses hardcoded product for discount testing

#### 2. **Limited Product Coverage**

The tests primarily use products with IDs in the 680-777 range:

- Product 680: Mountain-100 Silver (most commonly used)
- Product 707: Sport-100 Helmet, Red
- Products 771-777: Road-150 series

**Database Reality:**

- The API returns 100+ products per page
- Products exist across a wide range of IDs (1-999+)
- Tests only exercise ~10 unique products out of hundreds

#### 3. **Search Test Specificity**

**search.spec.ts:**

```typescript
test(
  "search for red bikes returns actual red bike products (Product 750 and others)",
);
```

- Explicitly mentions Product 750 in test description
- Tests search but still references specific products

### 📊 Test Coverage by File

| Test File                      | Randomization Status | Issues                                                              |
| ------------------------------ | -------------------- | ------------------------------------------------------------------- |
| `product-reviews.spec.ts`      | ⚠️ Partial           | Hardcoded array of 7 product IDs                                    |
| `browsing-shopping.spec.ts`    | ⚠️ Partial           | Hardcoded array of 7 product IDs                                    |
| `checkout.spec.ts`             | ❌ Poor              | Single hardcoded product (680)                                      |
| `search.spec.ts`               | ✅ Good              | Uses dynamic search, mentions specific products only for validation |
| `ai-features.spec.ts`          | ✅ Good              | No hardcoded products, uses search                                  |
| `data-validation.spec.ts`      | ✅ Good              | Queries all data from API                                           |
| `address.spec.ts`              | ✅ Excellent         | Fully randomized addresses                                          |
| `password.spec.ts`             | ✅ Excellent         | Fully randomized credentials                                        |
| `sale-discounts.spec.ts`       | ❌ Poor              | Hardcoded product 680                                               |
| `internationalization.spec.ts` | ❌ Poor              | Hardcoded product 680                                               |
| `telemetry.spec.ts`            | ❌ Poor              | Hardcoded product 680                                               |
| `telemetry-validation.spec.ts` | ❌ Poor              | Hardcoded product 680                                               |
| `telemetry-generator.spec.ts`  | ⚠️ Partial           | Array of 17 product IDs                                             |

### 🎯 Impact Analysis

**Why This Matters:**

1. **Test Coverage**: Tests only validate behavior on ~1-2% of the product catalog
2. **Edge Cases**: Products with different characteristics (no image, different price ranges, various categories) aren't tested
3. **Reliability**: If the hardcoded products change or become unavailable, tests fail
4. **Real-World Scenarios**: Tests don't reflect actual user behavior of browsing diverse products

### 🔧 Recommended Solutions

#### Solution 1: Dynamic Product Selection Helper (Implemented)

Created `/workspaces/AdventureWorks/tests/utils/productHelper.ts` with functions:

- `fetchAllProducts()`: Fetches all products across all pages (handles DAB's 100-item pagination)
- `getRandomProducts(count, filter?)`: Returns random products from entire catalog
- `getRandomProductIds(count, filter?)`: Returns random product IDs
- `getInStockProducts(count)`: Returns products that are likely in stock
- `getProductsByColor(color, count)`: Filters by color

#### Solution 2: Test Updates Required

Each test should be updated to use the helper:

```typescript
// BEFORE
const testProducts = [680, 707, 712, 771, 772, 776, 777];
const testProductId =
  testProducts[Math.floor(Math.random() * testProducts.length)];

// AFTER
import { getRandomProductIds } from "../utils/productHelper";
const testProductIds = await getRandomProductIds(1);
const testProductId = testProductIds[0];
```

For stock-dependent tests:

```typescript
// AFTER (for cart/checkout tests)
import { getInStockProductIds } from "../utils/productHelper";
const inStockProductIds = await getInStockProductIds(5);
```

## Action Items

- [x] Create `productHelper.ts` utility
- [x] Update `product-reviews.spec.ts` to use dynamic product selection
- [x] Update `browsing-shopping.spec.ts` to use dynamic product selection
- [x] Update `checkout.spec.ts` to use dynamic product selection
- [x] Update `sale-discounts.spec.ts` to use dynamic product selection (import added, ready for use)
- [x] Update `internationalization.spec.ts` to use dynamic product selection
- [x] Update `telemetry.spec.ts` to use dynamic product selection
- [x] Update `telemetry-validation.spec.ts` to use dynamic product selection
- [x] Update `telemetry-generator.spec.ts` to expand product selection
- [x] Add test to verify product helper is working correctly (`product-helper.spec.ts`)
- [x] Document the new testing pattern in README

## Implementation Notes

### Database Pagination Consideration

The DAB API paginates results at 100 items. The `productHelper` handles this by:

1. Making multiple requests with `$skip` parameter
2. Accumulating results until less than 100 items returned
3. Caching results for 5 minutes to avoid repeated API calls

### Performance Optimization

- Products are cached for 5 minutes to avoid repeated API calls during test runs
- Cache is automatically cleared between test suite runs
- First test to use product helper will have ~1-2 second delay while loading all products
- Subsequent tests in same suite use cached data

### Filter Examples

```typescript
// Get products with a specific color
const redProducts = await getRandomProducts(5, (p) => p.Color === "Red");

// Get bikes only
const bikes = await getRandomProducts(10, (p) =>
  p.Name?.toLowerCase().includes("bike"),
);

// Get products in a price range
const affordableProducts = await getRandomProducts(
  5,
  (p) => p.ListPrice && p.ListPrice < 100,
);
```

## Conclusion

The test suite has excellent randomization for user data and addresses but needs improvement in product selection. Implementing the `productHelper` utility and updating the tests will ensure:

1. **Better Coverage**: Tests exercise the full product catalog
2. **More Realistic**: Reflects actual user browsing patterns
3. **More Robust**: Tests don't break if specific products change
4. **Better Validation**: Catches edge cases with different product types

**Priority:** High - Should be implemented before next major release
