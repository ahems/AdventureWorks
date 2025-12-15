# Pay Button Implementation - Complete Order Flow

## Overview

Implemented a fully functional "Pay" button on the Payment Method page that:

- ✅ Creates real orders in the database via GraphQL mutations
- ✅ Shows the correct currency symbol dynamically
- ✅ Decrements product stock for purchased items
- ✅ Empties the user's shopping cart
- ✅ Handles errors gracefully with user feedback

## Implementation Details

### 1. GraphQL Mutations Added

#### Customer Management

```graphql
GET_CUSTOMER - Query to check if customer exists for PersonID
CREATE_CUSTOMER - Mutation to create new customer record
```

#### Order Creation

```graphql
CREATE_SALES_ORDER_HEADER - Creates the main order with:
  - OrderDate, DueDate
  - CustomerID, Addresses, ShipMethodID
  - SubTotal, TaxAmt, Freight
  - Returns: SalesOrderID

CREATE_SALES_ORDER_DETAIL - Adds line items with:
  - ProductID, OrderQty
  - UnitPrice, UnitPriceDiscount
  - Links to SalesOrderID
```

#### Inventory Management

```graphql
GET_PRODUCT_STOCK - Retrieves current SafetyStockLevel
UPDATE_PRODUCT_STOCK - Decrements stock by quantity purchased
```

#### Cart Management

```graphql
DELETE_CART_ITEM - Removes individual cart items by ShoppingCartItemID
```

### 2. Order Creation Flow

The `handlePlaceOrder` function now executes these steps:

1. **Save User Preferences** (optional)

   - Save shipping address if opted in
   - Save payment method if opted in

2. **Get or Create Customer**

   - Query for existing Customer by PersonID (businessEntityId)
   - Create new Customer if doesn't exist

3. **Create Sales Order Header**

   - Use selected/default shipping address
   - Use selected shipping method
   - Calculate totals (SubTotal, Tax, Freight)
   - Set order dates (OrderDate = now, DueDate = +7 days)
   - Status = 1 (pending), OnlineOrderFlag = true

4. **Create Order Details**

   - Loop through each cart item
   - Calculate unit price (with sales discount if applicable)
   - Calculate discount percentage
   - Create SalesOrderDetail record

5. **Update Product Stock**

   - For each purchased product:
   - Get current SafetyStockLevel
   - Decrement by quantity purchased
   - Update Product record
   - Continue even if stock update fails (demo mode)

6. **Clear Shopping Cart**

   - For each cart item with ShoppingCartItemID:
   - Delete via DELETE_CART_ITEM mutation
   - Continue even if delete fails

7. **Store Order Locally**

   - Save to localStorage for confirmation page
   - Add to order history
   - Generate order ID: `SO-{SalesOrderID}`

8. **Navigate to Confirmation**
   - Show success toast
   - Clear cart from UI
   - Navigate to `/order-confirmation`

### 3. Currency Symbol Support

Updated the Pay button to dynamically show the correct currency symbol:

**Before:**

```tsx
Pay $${grandTotal.toFixed(2)}
```

**After:**

```tsx
Pay ${CURRENCY_SYMBOLS[currencyCode] || currencyCode}${grandTotal.toFixed(2)}
```

Examples:

- USD: `Pay $123.45`
- CAD: `Pay CA$123.45`
- EUR: `Pay €123.45`
- GBP: `Pay £123.45`
- AUD: `Pay A$123.45`

### 4. Data Type Handling

**Important:** GraphQL Decimal and Short types require numeric values, not strings:

```typescript
// ✅ Correct
subTotal: parseFloat(totalPrice.toFixed(2));
taxAmt: parseFloat(tax.toFixed(2));
orderQty: item.quantity; // Already a number
newStock: Math.max(0, currentStock - item.quantity);

// ❌ Incorrect
subTotal: totalPrice.toFixed(2); // Returns string
```

### 5. Error Handling

Wrapped entire order creation in try-catch:

- Validates user authentication
- Validates address availability
- Catches GraphQL errors
- Shows descriptive error toasts
- Logs errors to console for debugging
- Continues processing even if stock/cart operations fail

### 6. Testing

Created comprehensive test script: `test-complete-order-flow.sh`

**Test Coverage:**

1. ✅ Customer lookup/creation
2. ✅ Sales order header creation
3. ✅ Order line items (multiple products)
4. ✅ Stock updates (decrement inventory)
5. ✅ Cart deletion

**Sample Test Results:**

```
Order ID: SO-75130
Customer ID: 30119
Total Items: 2 products
Total Amount: $67.30
  - Subtotal: $53.99
  - Tax: $4.32
  - Shipping: $8.99
```

## API Endpoints Used

**Base URL (Azure):**

```
https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql
```

**Entities Modified:**

- `customers` - Customer records
- `salesOrderHeaders` - Order headers
- `salesOrderDetails` - Order line items
- `products` - Product stock levels
- `shoppingCartItems` - Shopping cart

## Database Tables Affected

### Created/Updated:

- `Sales.Customer` - Customer records linked to PersonID
- `Sales.SalesOrderHeader` - Main order record
- `Sales.SalesOrderDetail` - Individual line items
- `Production.Product` - SafetyStockLevel decremented

### Deleted:

- `Sales.ShoppingCartItem` - All items for user's cart

## Integration Points

### Cart Context

- Uses `clearCart()` to refresh UI after order
- Relies on `items` array with ShoppingCartItemID

### Auth Context

- Uses `user.businessEntityId` as PersonID for Customer lookup
- Validates authentication before processing

### Address Management

- Uses `selectedAddressId` or first address
- Falls back to user-entered address data

### Payment Methods

- Saves payment method if opted in
- Uses selected or default payment method

## Future Enhancements

1. **Order Status Tracking**

   - Update order status based on payment result
   - Send email confirmations
   - Track shipping updates

2. **Inventory Validation**

   - Check stock before creating order
   - Prevent overselling
   - Show "out of stock" warnings

3. **Payment Processing**

   - Integrate real payment gateway
   - Handle payment failures
   - Support multiple payment types

4. **Order Confirmation**
   - Display full order details
   - Show estimated delivery date
   - Provide tracking information

## Files Modified

- `/app/src/pages/CheckoutPage.tsx` - Added mutations and order creation logic
- `/test-complete-order-flow.sh` - Comprehensive test script

## Demo Notes

- Negative stock is allowed (as requested)
- Order status defaults to 1 (pending)
- TerritoryID defaults to 1 for new customers
- SpecialOfferID defaults to 1 for line items
- Stock updates use SafetyStockLevel field (not actual inventory)

## Testing Instructions

1. **Manual Testing:**

   - Add items to cart
   - Proceed to checkout
   - Fill in shipping address
   - Select shipping method
   - Click "Continue to Payment"
   - Click "Pay" button
   - Verify order creation in confirmation page

2. **API Testing:**

   ```bash
   ./test-complete-order-flow.sh
   ```

3. **Verify in Database:**
   - Check `Sales.SalesOrderHeader` for new order
   - Check `Sales.SalesOrderDetail` for line items
   - Check `Production.Product` for updated stock
   - Check `Sales.ShoppingCartItem` (should be empty)
