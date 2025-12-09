# AdventureWorks App - GraphQL API Integration Summary

## Overview
Successfully migrated the AdventureWorks app from using mock data to fetching data from a GraphQL API. The API URL is configurable via environment variables.

## Changes Made

### 1. Dependencies Added
- `graphql` - GraphQL language support
- `graphql-request` - Lightweight GraphQL client

```bash
npm install graphql graphql-request
```

### 2. New Files Created

#### `/app/src/lib/graphql-client.ts`
GraphQL client singleton with environment-based configuration:
- Reads `VITE_API_URL` from environment variables
- Falls back to `http://localhost:5000/graphql` for development
- Configures headers for JSON requests

#### `/app/src/lib/graphql-queries.ts`
All GraphQL queries for the application:
- `GET_CATEGORIES` - Fetch all product categories
- `GET_SUBCATEGORIES` - Fetch all subcategories
- `GET_SUBCATEGORIES_BY_CATEGORY` - Filter subcategories by category
- `GET_PRODUCTS` - Fetch all products
- `GET_PRODUCT_BY_ID` - Fetch single product
- `GET_PRODUCTS_BY_SUBCATEGORY` - Filter products by subcategory
- `GET_CATEGORY_BY_ID` - Fetch single category
- `GET_SUBCATEGORY_BY_ID` - Fetch single subcategory

#### `/app/src/data/apiService.ts`
Service layer wrapping GraphQL queries:
- Async functions matching the original mock data API
- Error handling with console logging
- Helper function to add icon names to categories
- Backwards compatible with existing code

#### `/app/src/hooks/useProducts.ts`
React Query hooks for data fetching:
- `useCategories()` - 5-minute cache
- `useSubcategories()` - 5-minute cache
- `useProducts()` - 2-minute cache
- `useProduct(id)` - 2-minute cache
- `useProductsByCategory(categoryId)` - 2-minute cache
- `useProductsBySubcategory(subcategoryId)` - 2-minute cache
- `useFeaturedProducts()` - 2-minute cache
- `useSaleProducts()` - 2-minute cache

All hooks return `{ data, isLoading, error }` for easy consumption.

### 3. Updated Components

#### Components Directory
- ✅ `CategoryGrid.tsx` - Uses `useCategories()`, added loading state
- ✅ `FeaturedProducts.tsx` - Uses `useFeaturedProducts()`, added loading state
- ✅ `PromoBanner.tsx` - Uses `useSaleProducts()`
- ✅ `Footer.tsx` - Uses `useCategories()`
- ✅ `Header.tsx` - Uses `useCategories()`

#### Pages Directory
- ✅ `ProductPage.tsx` - Uses `useProduct()`, `useCategory()`, `useSubcategory()` with loading states
- ✅ `CategoryPage.tsx` - Uses `useCategory()`, `useSubcategoriesByCategory()`, `useProductsByCategory()` with loading states
- ✅ `SalePage.tsx` - Uses `useSaleProducts()`
- ✅ `SearchPage.tsx` - Uses `useProducts()`, `useCategories()`, `useSubcategories()`

### 4. Environment Configuration

#### `/app/.env` (Development)
```env
VITE_API_URL=https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql
```

#### `/app/.env.example` (Template)
Template file for other developers.

#### `/app/src/vite-env.d.ts` (TypeScript Definitions)
Added TypeScript interfaces for environment variables:
```typescript
interface ImportMetaEnv {
  readonly VITE_API_URL: string
}
```

#### `/app/.gitignore` (Updated)
Added environment files to gitignore:
```
.env
.env.local
.env.*.local
```

### 5. Documentation

#### `/app/GRAPHQL_INTEGRATION.md`
Comprehensive documentation including:
- Architecture overview
- Query examples
- Component updates
- Deployment notes
- Troubleshooting guide
- Known limitations

#### `/app/test-api.sh`
Bash script to test GraphQL API connectivity and queries.

## Migration Path

### Before (Mock Data)
```typescript
import { getProductById } from '@/data/mockData';

const product = getProductById(123);
```

### After (GraphQL API)
```typescript
import { useProduct } from '@/hooks/useProducts';

const { data: product, isLoading } = useProduct(123);
```

## Key Benefits

1. **Real Data**: App now fetches real data from the AdventureWorks database
2. **Caching**: React Query automatically caches responses
3. **Loading States**: All components show loading indicators during data fetch
4. **Error Handling**: Graceful error handling with console logging
5. **Type Safety**: Full TypeScript support maintained
6. **Developer Experience**: Environment-based configuration for easy development/production setup

## Configuration for Different Environments

### Local Development
```bash
# In /app/.env
VITE_API_URL=http://localhost:5000/graphql
```

The app uses `VITE_API_URL` from the `.env` file during local development.

### Production (Azure Container Apps)

In production, the API URL is injected at **runtime** via the `API_URL` environment variable:

1. Set in Azure Container App environment (already configured in Bicep):
   ```bicep
   env: [
     {
       name: 'API_URL'
       value: apiUrl  // e.g., https://your-api.azurecontainerapps.io/graphql
     }
   ]
   ```

2. Docker entrypoint generates `/config.js` at startup:
   ```javascript
   window.APP_CONFIG = {
     API_URL: "https://your-api.azurecontainerapps.io/graphql"
   };
   ```

3. The app reads from `window.APP_CONFIG.API_URL` at runtime

**No rebuild required** when changing the API URL - just update the environment variable and restart the container.

## Testing the Integration

### 1. Install Dependencies
```bash
cd /workspaces/AdventureWorks/app
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your API URL
```

### 3. Test API Connection
```bash
./test-api.sh
```

### 4. Run Development Server
```bash
npm run dev
```

### 5. Verify Data Loading
- Open browser to http://localhost:5173
- Check browser console for GraphQL requests
- Verify categories and products load from API
- Check Network tab for GraphQL requests

## Known Issues & Limitations

### 1. Sale Products
The database doesn't have a discount/sale field. The `useSaleProducts()` hook returns empty array.

**Solutions**:
- Add `SalePrice` or `DiscountPercent` field to Product table
- Implement a separate Promotions table
- Use product tags/categories for sales

### 2. Product Images & Descriptions
The API returns basic product info without rich descriptions or images.

**Solutions**:
- Add `ImageUrl` and `Description` fields to database
- Store images in Azure Blob Storage
- Use a CDN for images

### 3. Product Variants (Size/Color)
Size and color variants are not in the database schema.

**Solutions**:
- Add ProductVariant table with Size, Color, SKU
- Implement product option groups
- Use JSON field for variant data

## Rollback Plan

If you need to rollback to mock data:

1. Revert component imports:
```typescript
// Change from:
import { useProducts } from '@/hooks/useProducts';
// Back to:
import { getProducts } from '@/data/mockData';
```

2. Remove async/loading patterns:
```typescript
// Change from:
const { data: products = [], isLoading } = useProducts();
// Back to:
const products = getProducts();
```

3. The mock data file still exists at `/app/src/data/mockData.ts`

## Next Steps

1. **API Testing**: Verify the GraphQL API is accessible and returns expected data format
2. **Data Validation**: Ensure all required fields are present in API responses
3. **Error Boundaries**: Add React error boundaries for better error handling
4. **Loading Skeletons**: Replace simple loading text with skeleton loaders
5. **Pagination**: Implement pagination for large product lists
6. **Search Optimization**: Add server-side search/filtering
7. **Image Management**: Set up image CDN and update product schema
8. **Sale Implementation**: Design and implement sale/discount system

## Support

For issues or questions:
- Check `/app/GRAPHQL_INTEGRATION.md` for detailed documentation
- Review GraphQL queries in `/app/src/lib/graphql-queries.ts`
- Test API connectivity with `/app/test-api.sh`
- Check browser console for error messages
