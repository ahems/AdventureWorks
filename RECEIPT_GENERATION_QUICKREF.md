# 🧾 Receipt Generation Quick Reference

## Endpoint

```
POST /api/GenerateOrderReceipts_HttpStart
```

## Request Format

```json
{
  "salesOrderNumbers": ["SO43659", "SO43660", "SO43661"]
}
```

## Response Format

```json
{
  "message": "Successfully enqueued 3 receipt generation job(s)",
  "enqueuedOrders": ["SO43659", "SO43660", "SO43661"],
  "totalEnqueued": 3
}
```

## Quick Test Commands

### Local Testing (bash)

```bash
# Single order
curl -X POST "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659"]}'

# Multiple orders
curl -X POST "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659", "SO43660", "SO43661"]}'

# Use test script
./test-receipt-generation.sh
```

### Local Testing (PowerShell)

```powershell
# Single order
$body = @{ salesOrderNumbers = @("SO43659") } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:7071/api/GenerateOrderReceipts_HttpStart" `
  -Method Post -Body $body -ContentType "application/json"

# Use test script
.\test-receipt-generation.ps1
```

## File Locations

### Source Files

- **Function**: [api-functions/Functions/GenerateOrderReceipts.cs](api-functions/Functions/GenerateOrderReceipts.cs)
- **Receipt Service**: [api-functions/Services/ReceiptService.cs](api-functions/Services/ReceiptService.cs)
- **PDF Generator**: [api-functions/Services/PdfReceiptGenerator.cs](api-functions/Services/PdfReceiptGenerator.cs)
- **Data Model**: [api-functions/Models/ReceiptData.cs](api-functions/Models/ReceiptData.cs)

### Documentation

- **Complete Guide**: [api-functions/RECEIPT_GENERATION.md](api-functions/RECEIPT_GENERATION.md)
- **Summary**: [RECEIPT_GENERATION_SUMMARY.md](RECEIPT_GENERATION_SUMMARY.md)
- **This File**: [RECEIPT_GENERATION_QUICKREF.md](RECEIPT_GENERATION_QUICKREF.md)

### Test Scripts

- **Bash**: [test-receipt-generation.sh](test-receipt-generation.sh)
- **PowerShell**: [test-receipt-generation.ps1](test-receipt-generation.ps1)

## Storage Locations

### Generated PDFs

- **Container**: `adventureworks-receipts`
- **Folder**: `CustomerReceipts/`
- **Filename Pattern**: `{SalesOrderNumber}.pdf`
- **Example**: `CustomerReceipts/SO43659.pdf`

### Queue

- **Queue Name**: `order-receipt-generation`
- **Poison Queue**: `order-receipt-generation-poison`

## Common Order Numbers

Query to find valid order numbers:

```sql
SELECT TOP 10 SalesOrderNumber, OrderDate, TotalDue
FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC
```

Common examples: `SO43659`, `SO43660`, `SO43661`, `SO43662`, etc.

## Monitoring

### Check Logs

```bash
# Watch function logs in real-time
func start --verbose

# Look for these messages:
# - "Enqueued receipt generation for order: SO43659"
# - "Processing receipt generation for order: SO43659"
# - "Successfully generated receipt for order SO43659. PDF available at: https://..."
```

### Application Insights Query

```kusto
traces
| where message contains "receipt"
| order by timestamp desc
| take 50
```

## Troubleshooting

### Function not responding?

```bash
# Check if function is running
curl http://localhost:7071/api/ping

# Rebuild and restart
cd api-functions
dotnet build
func start
```

### Can't find order?

```bash
# Verify order exists in database
# Check SalesOrderNumber format (e.g., "SO43659")
# Orders must exist in Sales.SalesOrderHeader table
```

### PDF not appearing in blob storage?

```bash
# Check queue processing in function logs
# Verify storage connection string
# Check for messages in poison queue (indicates failure)
# Review Application Insights for errors
```

## DoodleCSS Colors Used

- **Primary (Orange)**: `#FF5E5B` - Company name, totals, headers
- **Accent (Green)**: `#4a7c59` - Section titles, status, discounts
- **Background (Cream)**: `#FDF7F1` - Order info box
- **Secondary (Light Cream)**: `#E8DED3` - Table alternating rows
- **Text (Dark Gray)**: `#3c3c3c` - Body text

## Key Dependencies

- **QuestPDF**: `2024.12.3` (PDF generation)
- **Azure.Storage.Blobs**: `12.26.0` (Blob storage)
- **Azure.Storage.Queues**: `12.22.0` (Queue storage)
- **Dapper**: `2.1.66` (Database access)

## Build & Deploy

### Local Development

```bash
cd api-functions
dotnet restore
dotnet build
func start
```

### Production Deployment

```bash
azd up
# Function deploys automatically as part of Container Apps
```

## Support

For issues or questions:

1. Check [RECEIPT_GENERATION.md](api-functions/RECEIPT_GENERATION.md) for detailed docs
2. Review [RECEIPT_GENERATION_SUMMARY.md](RECEIPT_GENERATION_SUMMARY.md) for architecture
3. Check Application Insights for errors
4. Review function logs for debugging information

---

**Status**: ✅ Fully Implemented & Production Ready
