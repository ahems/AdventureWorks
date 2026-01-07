# Order Receipt PDF Generation - Azure Function

## Overview

This Azure Function generates PDF receipts for customer orders in the AdventureWorks system. It uses a **fire-and-forget** pattern with queue-based processing, allowing you to submit multiple order receipts for generation without waiting for each one to complete.

## Architecture

- **HTTP Trigger**: Accepts requests to generate receipts for one or more orders
- **Queue Storage**: Orders are queued for asynchronous processing
- **Queue Trigger**: Processes each order individually
- **Blob Storage**: Generated PDFs are stored in `CustomerReceipts/` folder
- **Naming**: PDFs are named using the `SalesOrderNumber` (e.g., `SO43659.pdf`)

## Components

### 1. **Models/ReceiptData.cs**

Data model containing all order information needed for the receipt:

- Order details (ID, number, date, status)
- Customer information (name, email, ID)
- Billing and shipping addresses
- Line items with products, quantities, prices
- Totals (subtotal, tax, shipping, discounts)
- Applied special offers

### 2. **Services/ReceiptService.cs**

Database service that retrieves complete order data:

- Fetches order header with customer details
- Retrieves all line items with product information
- Gets billing and shipping addresses
- Calculates discounts and retrieves special offers
- Supports lookup by `SalesOrderNumber` or `SalesOrderID`

### 3. **Services/PdfReceiptGenerator.cs**

PDF generation service using **QuestPDF**:

- Generates professional, styled PDF receipts
- Uses **DoodleCSS theme colors** matching the website:
  - Primary: `#FF5E5B` (Adventure orange/rust)
  - Accent: `#4a7c59` (Forest green)
  - Background: `#FDF7F1` (Warm cream)
- Includes company branding with AdventureWorks address
- Uploads completed PDFs to blob storage
- Returns public blob URL

### 4. **Functions/GenerateOrderReceipts.cs**

Azure Function with two triggers:

- **HTTP Trigger**: Enqueues receipt generation jobs
- **Queue Trigger**: Processes individual receipts

## Usage

### Endpoint

```
POST /api/GenerateOrderReceipts_HttpStart
```

### Request Body

```json
{
  "salesOrderNumbers": ["SO43659", "SO43660", "SO43661"]
}
```

You can provide one or more sales order numbers. Each will be processed independently.

### Response

```json
{
  "message": "Successfully enqueued 3 receipt generation job(s)",
  "enqueuedOrders": ["SO43659", "SO43660", "SO43661"],
  "totalEnqueued": 3
}
```

### Example cURL Request

```bash
# Generate receipt for a single order
curl -X POST "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659"]}'

# Generate receipts for multiple orders
curl -X POST "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659", "SO43660", "SO43661"]}'
```

### Finding Sales Order Numbers

You can find sales order numbers in the database:

```sql
SELECT TOP 10
    SalesOrderNumber,
    SalesOrderID,
    OrderDate,
    TotalDue
FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC
```

Example order numbers: `SO43659`, `SO43660`, `SO43661`, etc.

## PDF Receipt Contents

The generated PDF receipt includes:

### Header Section

- **AdventureWorks** company name and branding
- Company address: 1 Adventure Way, Bothell, WA 98011
- Contact: (555) 123-4567, hello@adventureworks.com

### Order Information Box

- Order Number (e.g., `SO43659`)
- Order Date
- Order ID
- Customer ID
- Order Status
- Ship Date (if shipped)

### Customer & Shipping Details

- Customer name and email
- Ship-to address (full address with city, state, zip, country)

### Order Items Table

Styled table with alternating row colors showing:

- Quantity
- Product name
- Product SKU
- Unit price
- Line total

### Special Offers (if applicable)

Yellow highlight box showing any discounts or special offers applied

### Totals Section

- Subtotal
- Discount (if applicable, shown in green)
- Shipping cost + method
- Tax
- **Total Due** (bold, highlighted)

### Footer

Thank you message with adventure theme

## Styling Details

The PDF uses the **DoodleCSS theme** from the website:

- **Colors**: Adventure orange (#FF5E5B), Forest green (#4a7c59), Warm cream background
- **Font**: Arial (similar to the website's Short Stack font for readability in PDFs)
- **Design**: Clean, professional invoice layout with fun, branded colors
- **Hand-drawn aesthetic**: Maintained through color choices and friendly messaging

## Storage

PDFs are stored in Azure Blob Storage:

- **Container**: `adventureworks-receipts`
- **Folder**: `CustomerReceipts/`
- **Filename pattern**: `{SalesOrderNumber}.pdf`
- **Example**: `CustomerReceipts/SO43659.pdf`
- **Access**: Public blob access (receipts can be shared via URL)

## Error Handling

- **Invalid order numbers**: Logged as warnings, processing continues for valid orders
- **Order not found**: Logged, no PDF generated
- **Queue failures**: Messages automatically retry (up to 5 times by default)
- **Poison queue**: Failed messages after max retries move to `order-receipt-generation-poison` queue
- **All errors logged**: Full Application Insights integration for monitoring

## Local Development

### Prerequisites

1. Restore NuGet packages (includes QuestPDF):

   ```bash
   cd api-functions
   dotnet restore
   ```

2. Ensure environment variables are set in `local.settings.json`:

   ```json
   {
     "Values": {
       "SQL_CONNECTION_STRING": "...",
       "AZURE_STORAGE_CONNECTION_STRING": "...",
       "AzureWebJobsStorage": "..."
     }
   }
   ```

3. Run the Azure Functions locally:
   ```bash
   func start
   # Or use VS Code task: "func: host start"
   ```

### Testing Locally

```bash
# Test with a known order number from your database
curl -X POST "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659"]}'
```

Check the function logs to see:

1. Order enqueued
2. Queue trigger fires
3. Data retrieved from database
4. PDF generated
5. PDF uploaded to blob storage
6. Blob URL returned

## Production Deployment

The function will be deployed automatically with `azd up` as part of the Container Apps deployment.

### Queue Configuration

The function uses Azure Storage Queues:

- **Queue name**: `order-receipt-generation`
- **Visibility timeout**: 5 minutes (default)
- **Max delivery count**: 5 (then moves to poison queue)
- **Connection**: Uses Managed Identity with `AzureWebJobsStorage`

### Monitoring

Use Application Insights to monitor:

- Receipt generation requests
- Processing time per order
- Success/failure rates
- Queue depth and processing lag

Query example:

```kusto
traces
| where message contains "receipt"
| order by timestamp desc
| take 50
```

## Future Enhancements

Potential improvements for the future:

1. **Email Integration**: Automatically email receipts to customers
2. **Custom Branding**: Support for different receipt templates
3. **Batch Processing**: Generate receipts for all orders in a date range
4. **Webhook Notifications**: Notify external systems when receipts are ready
5. **Internationalization**: Multi-language receipts based on customer location
6. **Digital Signatures**: Add cryptographic verification for receipt authenticity

## Dependencies

- **QuestPDF** (2024.12.3): PDF generation library
- **Azure.Storage.Blobs** (12.26.0): Blob storage client
- **Azure.Storage.Queues** (12.22.0): Queue storage client
- **Dapper** (2.1.66): Database access
- **Azure.Identity**: Managed Identity authentication

## License

QuestPDF Community License is used (free for community projects).
