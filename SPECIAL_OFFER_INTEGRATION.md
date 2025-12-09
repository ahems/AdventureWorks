# Special Offer Discount Integration

## Overview
Successfully integrated customer special offers from the `Sales.SpecialOffer` table to display discounts on products throughout the application.

## Database Structure
- **SpecialOffer Table**: Contains discount information including DiscountPct, Description, Category
- **SpecialOfferProduct Table**: Junction table linking ProductID to SpecialOfferID
- **Filter Criteria**: Only show discounts where Category = "Customer"

## Implementation Details

### 1. Type Definitions (`app/src/types/product.ts`)
Added discount-related fields to the Product interface:
```typescript
SpecialOfferID?: number;
DiscountPct?: number; // Decimal format (0.5 = 50%)
SpecialOfferDescription?: string;
```

Added new interfaces:
- `SpecialOffer`: Full special offer details
- `SpecialOfferProduct`: Junction table mapping

Updated `getSalePrice()` function to prioritize `DiscountPct` from API over legacy `salePercent`.

### 2. GraphQL Queries (`app/src/lib/graphql-queries.ts`)
Added two new queries:
- `GET_CUSTOMER_SPECIAL_OFFERS`: Fetches all special offers with Category = "Customer"
- `GET_SPECIAL_OFFER_PRODUCTS`: Fetches product-offer mappings for given offer IDs

### 3. API Service (`app/src/data/apiService.ts`)
Created `attachDiscountsToProducts()` helper function that:
1. Fetches all customer special offers
2. Fetches product-offer mappings for those offers
3. Creates lookup maps for efficient data attachment
4. Attaches discount data (SpecialOfferID, DiscountPct, SpecialOfferDescription) to products

Updated all product fetching functions to call `attachDiscountsToProducts()`:
- `getProducts()`
- `getProductById()`
- `getProductsBySubcategory()`
- `getProductsByCategory()`
- `getSaleProducts()` - now returns actual products with discounts instead of empty array

### 4. UI Components

#### ProductCard (`app/src/components/ProductCard.tsx`)
Updated sale badge to use `DiscountPct` or fallback to `salePercent`:
```typescript
{(product.DiscountPct || product.salePercent) && (
  <div className="...">
    {variant === 'featured' ? 'Limited-Time Special' : 
     `${Math.round((product.DiscountPct || product.salePercent! / 100) * 100)}% OFF`}
  </div>
)}
```

#### ProductPage (`app/src/pages/ProductPage.tsx`)
Updated two areas:
1. Sale badge display
2. Savings percentage calculation

#### QuickViewModal (`app/src/components/QuickViewModal.tsx`)
Updated sale badge and savings display to use `DiscountPct`.

## Current Discounts in Database

### Mountain Tire Sale (Offer ID: 10)
- **Discount**: 50% off
- **Products**: 
  - 928: LL Mountain Tire ($24.99 → $12.50)
  - 929: ML Mountain Tire
  - 930: HL Mountain Tire

### Half-Price Pedal Sale (Offer ID: 15)
- **Discount**: 50% off
- **Products**:
  - 935: LL Mountain Pedal ($40.49 → $20.25)
  - 936: ML Mountain Pedal
  - 937: HL Mountain Pedal
  - 938: LL Road Pedal
  - 939: ML Road Pedal
  - 940: HL Road Pedal
  - 941: ML Touring Pedal

## Testing
Run the test script to verify discount integration:
```bash
./test-discounts.sh
```

## Deployment
The changes have been deployed to:
- **App URL**: https://todoapp-app-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/
- **API URL**: https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql/

## How It Works

1. **Data Fetching**: When products are fetched, `attachDiscountsToProducts()` is called
2. **Batch Processing**: All customer special offers are fetched once, then product mappings are retrieved
3. **Efficient Lookup**: Maps are created for O(1) lookups when attaching discounts to products
4. **UI Display**: Components check for `DiscountPct` field and display sale badges and discounted prices
5. **Price Calculation**: `getSalePrice()` uses `DiscountPct` (decimal: 0.5 = 50%) to calculate sale price

## Notes
- StartDate and EndDate fields are currently ignored as requested
- Only discounts with Category = "Customer" are shown
- DiscountPct is stored as decimal (0.5 = 50% off)
- Backward compatible with legacy `salePercent` field (percentage: 50 = 50% off)
- All product fetching functions now include discount data automatically
