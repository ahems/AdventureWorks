# Generate and Send Receipt Function

## Overview

The `GenerateAndSendReceipt` function orchestrates the complete order confirmation workflow:

1. Generates a PDF receipt for the order
2. Uploads the PDF to Azure Blob Storage
3. Sends an email to the customer's selected email address with the PDF attached

## Endpoint

```
POST /api/orders/generate-and-send-receipt
```

## Request Body

```json
{
  "salesOrderId": 12345,
  "customerId": 67890,
  "emailAddressId": 42
}
```

### Parameters

- **salesOrderId** (int, required): The SalesOrderID from `Sales.SalesOrderHeader`
- **customerId** (int, required): The CustomerID from `Sales.Customer`
- **emailAddressId** (int, required): The EmailAddressID from `Person.EmailAddress` (selected by customer during checkout)

## Response

**HTTP 202 Accepted** - Request accepted for background processing

```json
{
  "message": "Receipt generation and email delivery initiated",
  "salesOrderId": 12345,
  "customerId": 67890,
  "emailAddressId": 42
}
```

**HTTP 400 Bad Request** - Invalid parameters

```json
{
  "error": "SalesOrderId is required and must be greater than 0"
}
```

## Fire-and-Forget Pattern

This function uses a fire-and-forget pattern:

- Returns HTTP 202 immediately after validation
- Processing happens asynchronously in the background
- UI doesn't need to wait for completion

## Processing Flow

1. **Validation** - Validates all required parameters
2. **Return Immediately** - Returns HTTP 202 to caller
3. **Background Processing**:
   - Fetches order data from database using `ReceiptService`
   - Generates PDF receipt using `PdfReceiptGenerator`
   - Uploads PDF to Azure Blob Storage
   - Sends email with PDF attachment using `EmailService`

## Integration with Checkout

Called from `OrderConfirmationPage.tsx` after order is created:

```typescript
const response = await fetch(
  `${functionsApiUrl}/api/orders/generate-and-send-receipt`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      salesOrderId: salesOrderId,
      customerId: orderData.CustomerID,
      emailAddressId: selectedEmailId,
    }),
  }
);
```

## Email Address Selection

The `emailAddressId` comes from the checkout flow:

1. User selects/adds email during checkout
2. EmailAddressId stored in localStorage as `checkout_email_id`
3. Passed to order confirmation page via URL
4. Used to call this function
5. Cleared from localStorage after use

## Error Handling

- All errors are logged but don't stop the order creation
- Email delivery failures are logged as warnings
- Receipt generation failures are logged as errors
- Function is idempotent - can be retried safely

## Dependencies

- **ReceiptService** - Fetches order data from database
- **PdfReceiptGenerator** - Creates and uploads PDF receipts
- **EmailService** - Sends emails via Azure Communication Services

## Testing

```bash
# Test the endpoint
curl -X POST http://localhost:7071/api/orders/generate-and-send-receipt \
  -H "Content-Type: application/json" \
  -d '{
    "salesOrderId": 43659,
    "customerId": 29825,
    "emailAddressId": 1
  }'
```

## Monitoring

Check Application Insights for:

- Request tracking: `GenerateAndSendReceipt`
- Custom events: Background processing logs
- Failures: Email delivery or PDF generation issues
