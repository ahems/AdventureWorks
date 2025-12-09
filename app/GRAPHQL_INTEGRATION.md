# GraphQL API Integration

This document describes the changes made to integrate the AdventureWorks app with the GraphQL API.

## Overview

The application has been updated to fetch data from a GraphQL API instead of using mock data. The integration uses `graphql-request` for API calls and React Query for caching and state management.

## Environment Variables

### Development
Create a `.env` file in the `app/` directory:

```bash
VITE_API_URL=https://your-api-url.azurecontainerapps.io/graphql
```

### Production
Set the `VITE_API_URL` environment variable in your deployment configuration.

For Azure Container Apps or Static Web Apps, you can set this as an application setting.

## Architecture

### 1. GraphQL Client (`src/lib/graphql-client.ts`)
- Singleton GraphQL client using `graphql-request`
- Reads API URL from `VITE_API_URL` environment variable
- Falls back to `http://localhost:5000/graphql` if not set

### 2. GraphQL Queries (`src/lib/graphql-queries.ts`)
Defines all GraphQL queries for:
- Product categories
- Product subcategories
- Products
- Filtering by category/subcategory
- Individual product lookup

### 3. API Service (`src/data/apiService.ts`)
Service layer that:
- Wraps GraphQL queries
- Handles errors gracefully
- Adds computed fields (like icon names for categories)
- Maintains backwards compatibility with existing code

### 4. React Hooks (`src/hooks/useProducts.ts`)
React Query hooks for data fetching:
- `useCategories()` - Fetch all categories
- `useSubcategories()` - Fetch all subcategories
- `useProducts()` - Fetch all products
- `useProduct(id)` - Fetch single product
- `useProductsByCategory(categoryId)` - Fetch products by category
- `useProductsBySubcategory(subcategoryId)` - Fetch products by subcategory
- `useFeaturedProducts()` - Fetch featured products
- `useSaleProducts()` - Fetch products on sale

Benefits:
- Automatic caching (5 minutes for categories, 2 minutes for products)
- Loading states
- Error handling
- Automatic refetching

## Updated Components

All components have been updated to use the new hooks:

### Components
- `CategoryGrid.tsx` - Uses `useCategories()`
- `FeaturedProducts.tsx` - Uses `useFeaturedProducts()`
- `PromoBanner.tsx` - Uses `useSaleProducts()`
- `Footer.tsx` - Uses `useCategories()`
- `Header.tsx` - Uses `useCategories()`

### Pages
- `ProductPage.tsx` - Uses `useProduct()`, `useCategory()`, `useSubcategory()`
- `CategoryPage.tsx` - Uses `useCategory()`, `useSubcategoriesByCategory()`, `useProductsByCategory()`
- `SalePage.tsx` - Uses `useSaleProducts()`
- `SearchPage.tsx` - Uses `useProducts()`, `useCategories()`, `useSubcategories()`

## GraphQL Query Examples

### Get All Categories
```graphql
query GetCategories {
  productCategories {
    items {
      ProductCategoryID
      Name
    }
  }
}
```

### Get Products by Category
```graphql
query GetProductsBySubcategory($subcategoryId: Int!) {
  products(filter: { ProductSubcategoryID: { eq: $subcategoryId } }) {
    items {
      ProductID
      Name
      ProductNumber
      Color
      ListPrice
      Size
      Weight
      ProductSubcategoryID
      ProductModelID
    }
  }
}
```

## API Requirements

The GraphQL API must support the following queries:
- `productCategories` - Returns list of product categories
- `productSubcategories` - Returns list of product subcategories
- `products` - Returns list of products

Each query should support:
- `filter` parameter for filtering results
- Nested `items` array containing the actual data

## Testing the API

You can test the GraphQL API using curl:

```bash
curl -X POST $VITE_API_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productCategories { items { ProductCategoryID Name } } }"}'
```

Or use the GraphQL playground (if available):
```
https://your-api-url.azurecontainerapps.io/graphql
```

## Fallback Behavior

If the API is unavailable:
- Components show loading states
- Errors are logged to console
- Empty arrays are returned instead of failing

## Migration from Mock Data

The old mock data file (`src/data/mockData.ts`) is still present but no longer used. You can:
1. Keep it as a reference
2. Use it for testing/development
3. Remove it once the API integration is stable

## Known Limitations

1. **Sale Products**: The API doesn't currently have discount/sale information. The `getSaleProducts()` function returns an empty array. You may need to:
   - Add a discount field to the database
   - Implement a separate sale/promotion system
   - Use a different approach for sales

2. **Product Images**: The API returns basic product data. Images and descriptions may need to be:
   - Stored separately (CDN, blob storage)
   - Added as additional fields in the database
   - Generated/mapped on the client side

3. **Product Variants**: Size/color variants are not in the database schema. These are currently mocked in the frontend.

## Deployment Notes

### Environment Variable Injection
For production deployments, you can inject the API URL at build time or runtime:

**Build time (Vite)**:
```bash
VITE_API_URL=https://production-api.azurecontainerapps.io/graphql npm run build
```

**Runtime (Azure Static Web Apps)**:
Configure in `staticwebapp.config.json` or via Azure Portal application settings.

### CORS Configuration
Ensure your API server allows requests from your app's domain:
```
Access-Control-Allow-Origin: https://your-app-domain.com
```

## Troubleshooting

### API Not Loading
1. Check the environment variable is set correctly
2. Verify the API URL is accessible
3. Check browser console for CORS errors
4. Ensure GraphQL endpoint is `/graphql` not `/api/graphql`

### Slow Loading
1. Check network latency to API server
2. Consider adding loading indicators
3. Adjust React Query stale times if needed

### Data Not Matching
1. Verify GraphQL query field names match database schema
2. Check API response structure (should have `items` array)
3. Look for errors in browser console

## Future Enhancements

1. Add mutations for cart/wishlist persistence
2. Implement user-specific data fetching
3. Add optimistic updates for better UX
4. Implement pagination for large product lists
5. Add server-side filtering/sorting
6. Cache product images more aggressively
