# Inventory Integration - Testing Checklist

## Manual Testing Guide

### Test Products

#### Product 928 - HL Mountain Tire (IN STOCK)
- **Expected Inventory:** 609 units (240 + 369 across 2 locations)
- **URL:** http://localhost:8080/product/928
- **Test:**
  - [ ] Product detail page shows green "IN STOCK" badge
  - [ ] Shows "609 units available"
  - [ ] "Add to Cart" button is enabled
  - [ ] Product card on listing pages does NOT show "OUT OF STOCK" badge
  - [ ] "Add to Cart" button on card is enabled

#### Product 680 - HL Road Frame - Black, 58 (OUT OF STOCK)
- **Expected Inventory:** 0 units (no inventory records)
- **URL:** http://localhost:8080/product/680
- **Test:**
  - [ ] Product detail page shows red "OUT OF STOCK" badge
  - [ ] Shows "Currently unavailable"
  - [ ] "Add to Cart" button is disabled
  - [ ] Button text shows "Out of Stock"
  - [ ] Product card shows "OUT OF STOCK" badge
  - [ ] "Add to Cart" button on card is disabled with "N/A" text

#### Product 707 - Sport-100 Helmet (IN STOCK, LOW INVENTORY)
- **Expected Inventory:** 288 units (below 300 threshold)
- **URL:** http://localhost:8080/product/707
- **Test:**
  - [ ] Product detail page shows green "IN STOCK" badge
  - [ ] Shows "288 units available"
  - [ ] "Add to Cart" button is enabled
  - [ ] Product card does NOT show "OUT OF STOCK" badge
  - [ ] If quantity < 50, card shows "LOW STOCK" badge (orange)

### Page-by-Page Testing

#### Homepage (/)
- [ ] Featured products load with inventory data
- [ ] Products with inventory show normal state
- [ ] Out-of-stock products show "OUT OF STOCK" badge
- [ ] Add to Cart buttons work only for in-stock items

#### Products Page (/products)
- [ ] All product cards display correctly
- [ ] Stock badges appear where appropriate
- [ ] Console logs show inventory fetching:
  ```
  📦 [attachInventoryToProducts] Fetching inventory for products...
  ✅ Inventory attached: X in stock, Y out of stock, Z no records
  ```

#### Sale Page (/sale)
- [ ] Sale product cards show inventory status
- [ ] Out-of-stock sale items are clearly marked
- [ ] "Add to Cart" disabled for unavailable items
- [ ] Console shows sale products with inventory attached

#### Category Pages (e.g., /category/1)
- [ ] Category products include inventory data
- [ ] Stock indicators display correctly
- [ ] Filtering works with inventory status

#### Subcategory Pages (e.g., /subcategory/1)
- [ ] Subcategory products include inventory data
- [ ] Stock badges visible
- [ ] Add to Cart functionality respects stock status

### Browser Console Checks

Open browser console (F12) and verify:

1. **Initial Load:**
   ```
   📦 [attachInventoryToProducts] Fetching inventory for products...
     🔍 Fetching inventory in X batches...
     📋 Found Y inventory records
     ✅ Inventory attached: A in stock, B out of stock, C no records
   ```

2. **No Errors:**
   - [ ] No TypeScript compilation errors
   - [ ] No GraphQL query errors
   - [ ] No missing property warnings

3. **Network Tab:**
   - [ ] Check GraphQL requests include `productInventories` queries
   - [ ] Verify inventory data in response payloads

### API Direct Testing

Run these commands in terminal:

```bash
# Test product 928 (should return 609)
curl -s -X POST "https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql/" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productInventories(filter: { ProductID: { eq: 928 } }) { items { Quantity } } }"}' \
  | jq '.data.productInventories.items | map(.Quantity) | add'

# Test product 680 (should return empty/null)
curl -s -X POST "https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql/" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productInventories(filter: { ProductID: { eq: 680 } }) { items { Quantity } } }"}' \
  | jq '.data.productInventories.items | length'
```

### Functional Testing

#### Add to Cart Behavior
1. **In-Stock Product:**
   - [ ] Click "Add to Cart" on product 928
   - [ ] Verify product added to cart
   - [ ] Cart shows correct quantity

2. **Out-of-Stock Product:**
   - [ ] Try clicking "Add to Cart" on product 680
   - [ ] Button should be disabled
   - [ ] No item added to cart

#### Product Variants (if applicable)
- [ ] Size/color variants respect stock status
- [ ] Unavailable variant combinations show warning
- [ ] "Notify me" feature works for out-of-stock variants

### Performance Testing

1. **Load Time:**
   - [ ] Initial product list loads within acceptable time
   - [ ] Inventory fetch completes within 2-3 seconds
   - [ ] No significant lag when navigating pages

2. **Batching:**
   - [ ] Console shows appropriate batch count (295 products / 100 = 3 batches)
   - [ ] No API 400 errors due to over-limit requests

### Edge Cases

1. **Zero Inventory:**
   - [ ] Products with 0 quantity show as out of stock
   - [ ] Add to Cart button disabled

2. **No Inventory Records:**
   - [ ] Products with no DB records default to 0 quantity
   - [ ] Treated same as zero inventory

3. **Low Stock (< 50 units):**
   - [ ] Orange "LOW STOCK" badge appears on product cards
   - [ ] Products still purchasable (not disabled)

### Regression Testing

Verify existing features still work:

- [ ] Discount badges display correctly
- [ ] Product photos load
- [ ] Product descriptions show
- [ ] Reviews display properly
- [ ] Wishlist functionality works
- [ ] Compare functionality works
- [ ] Search/filtering works
- [ ] Sale badge shows on discounted items

## Test Results

### Date: ________________
### Tester: ________________

**Products Tested:**
- [ ] Product 928 - IN STOCK ✅
- [ ] Product 680 - OUT OF STOCK ❌
- [ ] Product 707 - IN STOCK ✅

**Pages Tested:**
- [ ] Homepage
- [ ] Products listing
- [ ] Product detail (multiple)
- [ ] Sale page
- [ ] Category pages
- [ ] Subcategory pages

**Overall Result:** ☐ Pass  ☐ Fail

**Notes:**
_________________________________________________
_________________________________________________
_________________________________________________
