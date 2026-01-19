# Order Receipt Generation - Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ORDER RECEIPT GENERATION FLOW                          │
└─────────────────────────────────────────────────────────────────────────────┘

                              CLIENT REQUEST
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  POST /api/Generate           │
                    │     OrderReceipts_HttpStart   │
                    │                               │
                    │  Body:                        │
                    │  {                            │
                    │    "salesOrderNumbers": [     │
                    │      "SO43659",               │
                    │      "SO43660",               │
                    │      "SO43661"                │
                    │    ]                          │
                    │  }                            │
                    └───────────┬───────────────────┘
                                │
                                ▼
                    ┌───────────────────────────────┐
                    │   GenerateOrderReceipts       │
                    │   _HttpStart Function         │
                    │                               │
                    │  • Validates request          │
                    │  • Creates queue client       │
                    │  • Enqueues each order        │
                    │  • Returns 202 Accepted       │
                    └───────────┬───────────────────┘
                                │
                                │  Enqueue Messages
                                ▼
            ┌───────────────────────────────────────────┐
            │   Azure Queue Storage                      │
            │   "order-receipt-generation"              │
            │                                           │
            │   Message 1: {"SalesOrderNumber":"SO43659"}│
            │   Message 2: {"SalesOrderNumber":"SO43660"}│
            │   Message 3: {"SalesOrderNumber":"SO43661"}│
            └───────────┬───────────────────────────────┘
                        │
                        │  Queue Trigger (one at a time)
                        ▼
        ┌───────────────────────────────────────────────┐
        │   GenerateOrderReceipts_QueueTrigger          │
        │                                               │
        │   Processes each order independently:         │
        │   1. Parse queue message                      │
        │   2. Call ReceiptService                      │
        │   3. Call PdfReceiptGenerator                 │
        │   4. Upload to blob storage                   │
        └───────┬───────────────────────────────────────┘
                │
                ├─────────────► ReceiptService
                │                     │
                │                     ▼
                │               ┌──────────────────────────┐
                │               │   Azure SQL Database     │
                │               │   AdventureWorks         │
                │               │                          │
                │               │  • Sales.SalesOrderHeader│
                │               │  • Sales.SalesOrderDetail│
                │               │  • Sales.Customer        │
                │               │  • Person.Person         │
                │               │  • Person.Address        │
                │               │  • Sales.SpecialOffer    │
                │               │  • Production.Product    │
                │               └────────┬─────────────────┘
                │                        │
                │                        ▼
                │               ┌──────────────────────────┐
                │               │    ReceiptData Object    │
                │               │                          │
                │               │  • Order details         │
                │               │  • Customer info         │
                │               │  • Addresses             │
                │               │  • Line items            │
                │               │  • Totals & discounts    │
                │               └────────┬─────────────────┘
                │                        │
                ▼                        │
                ├────────────────────────┘
                │
                ▼
        PdfReceiptGenerator
                │
                ▼
        ┌───────────────────────────────────────────────┐
        │            QuestPDF                           │
        │                                               │
        │  Generates PDF with:                          │
        │  • Company header (AdventureWorks branding)   │
        │  • Order information box                      │
        │  • Customer & shipping details                │
        │  • Line items table (styled)                  │
        │  • Special offers (if any)                    │
        │  • Totals section                             │
        │  • Thank you footer                           │
        │                                               │
        │  Styling:                                     │
        │  • DoodleCSS colors (#FF5E5B, #4a7c59)       │
        │  • Professional invoice layout                │
        │  • Alternating table rows                     │
        │  • Hand-drawn aesthetic                       │
        └───────────┬───────────────────────────────────┘
                    │
                    │  PDF Bytes (in memory)
                    ▼
        ┌───────────────────────────────────────────────┐
        │      Azure Blob Storage Upload                │
        │                                               │
        │  Container: adventureworks-receipts           │
        │  Path: CustomerReceipts/SO43659.pdf           │
        │  Access: Public                               │
        └───────────┬───────────────────────────────────┘
                    │
                    │  Blob URL returned
                    ▼
        ┌───────────────────────────────────────────────┐
        │           SUCCESS LOG                         │
        │                                               │
        │  "Successfully generated receipt for order    │
        │   SO43659. PDF available at:                  │
        │   https://storage.blob.core.windows.net/      │
        │   adventureworks-receipts/CustomerReceipts/   │
        │   SO43659.pdf"                                │
        └───────────────────────────────────────────────┘


════════════════════════════════════════════════════════════════════════════════

                            ERROR HANDLING FLOW

        Queue Trigger Process
               │
               ▼
        First Attempt Fails
               │
               ▼
        Automatic Retry (2nd attempt)
               │
               ▼
        Still Fails
               │
               ▼
        Automatic Retry (3rd attempt)
               │
               ▼
        Still Fails
               │
               ▼
        Automatic Retry (4th attempt)
               │
               ▼
        Still Fails
               │
               ▼
        Automatic Retry (5th attempt - final)
               │
               ▼
        Still Fails
               │
               ▼
        Move to Poison Queue
               │
               ▼
        "order-receipt-generation-poison"
               │
               ▼
        Alert/Monitor for investigation


════════════════════════════════════════════════════════════════════════════════

                        PARALLEL PROCESSING EXAMPLE

    HTTP Request with 3 orders → Queue receives 3 messages
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              [Message 1]           [Message 2]           [Message 3]
              SO43659              SO43660              SO43661
                    │                    │                    │
                    ▼                    ▼                    ▼
              Worker 1             Worker 2             Worker 3
              (if scaled)          (if scaled)          (if scaled)
                    │                    │                    │
                    ▼                    ▼                    ▼
              PDF Generated        PDF Generated        PDF Generated
                    │                    │                    │
                    ▼                    ▼                    ▼
              SO43659.pdf          SO43660.pdf          SO43661.pdf
              uploaded             uploaded             uploaded


════════════════════════════════════════════════════════════════════════════════

                            DATA FLOW DETAILS

    ReceiptService.GetReceiptDataBySalesOrderNumberAsync("SO43659")
                                │
                                ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  SQL Query 1: Order Header                                    │
    │  ────────────────────────────                                 │
    │  SELECT soh.*, cust.*, person.*, addresses.*, shipMethod.*    │
    │  FROM Sales.SalesOrderHeader soh                              │
    │  JOIN Sales.Customer cust ...                                 │
    │  JOIN Person.Person p ...                                     │
    │  JOIN Person.Address shipAddr ...                             │
    │  JOIN Person.Address billAddr ...                             │
    │  WHERE soh.SalesOrderNumber = 'SO43659'                       │
    └───────────────────────┬───────────────────────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  SQL Query 2: Line Items                                      │
    │  ─────────────────────────                                    │
    │  SELECT sod.*, product.*                                      │
    │  FROM Sales.SalesOrderDetail sod                              │
    │  JOIN Production.Product p ...                                │
    │  WHERE sod.SalesOrderID = @SalesOrderID                       │
    │  ORDER BY sod.SalesOrderDetailID                              │
    └───────────────────────┬───────────────────────────────────────┘
                            │
                            ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  SQL Query 3: Special Offers                                  │
    │  ──────────────────────────────                               │
    │  SELECT DISTINCT so.Description                               │
    │  FROM Sales.SalesOrderDetail sod                              │
    │  JOIN Sales.SpecialOfferProduct sop ...                       │
    │  JOIN Sales.SpecialOffer so ...                               │
    │  WHERE sod.SalesOrderID = @SalesOrderID                       │
    │    AND so.SpecialOfferID > 1                                  │
    └───────────────────────┬───────────────────────────────────────┘
                            │
                            ▼
                    ReceiptData object
                    (ready for PDF generation)


════════════════════════════════════════════════════════════════════════════════
```
