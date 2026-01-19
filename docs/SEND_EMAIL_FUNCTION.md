# Customer Email Function

Azure Function for sending emails to customers using Azure Communication Services.

## Overview

The `SendCustomerEmail` function enables sending personalized emails to customers with optional file attachments from Azure Storage. The function uses:

- **Azure Communication Services** for email delivery
- **Managed Identity** for passwordless authentication
- **SQL Database** to validate customer information
- **Azure Blob Storage** for retrieving attachments

## Endpoint

```
POST /api/customers/{customerId}/send-email
```

## Request Body

```json
{
  "emailAddress": "customer@example.com",
  "subject": "Email Subject",
  "content": "Plain text email content",
  "attachmentUrl": "https://storageaccount.blob.core.windows.net/container/file.pdf" // Optional
}
```

### Parameters

- **customerId** (path): The customer's ID from `Sales.Customer` table
- **emailAddress** (body, required): The customer's email address (must exist in `Person.EmailAddress` for this customer)
- **subject** (body, required): Email subject line
- **content** (body, required): Plain text email content
- **attachmentUrl** (body, optional): URL to a file in Azure Storage to attach (e.g., receipt PDF)

## Validation

The function validates that:

1. The email address belongs to the specified customer (checks `Person.EmailAddress` table)
2. The customer exists and has a valid person record
3. All required fields are provided

## Attachments

If an `attachmentUrl` is provided:

- The function uses the shared User Managed Identity to download the file from Azure Storage
- The file is attached to the email automatically
- Supports any file type stored in the configured storage account

## Authentication

- Uses **DefaultAzureCredential** (managed identity in Azure, Azure CLI locally)
- Passwordless connections to:
  - Azure SQL Database
  - Azure Communication Services
  - Azure Blob Storage

## Environment Variables

Required environment variables (automatically configured by Bicep):

- `SQL_CONNECTION_STRING` - Database connection string
- `COMMUNICATION_SERVICE_ENDPOINT` - Azure Communication Services endpoint
- `EMAIL_SENDER_DOMAIN` - Email sender domain (e.g., `*.azurecomm.net`)
- `AzureWebJobsStorage__accountName` - Storage account name for attachments
- `AZURE_CLIENT_ID` - User-assigned managed identity client ID

## Fire and Forget

The email is sent asynchronously using `WaitUntil.Started`, meaning:

- The function returns immediately after submitting the email
- Actual delivery happens in the background
- The message ID is logged for tracking

## Example Usage

### Simple Email

```bash
curl -X POST "https://your-functions-app.azurecontainerapps.io/api/customers/1/send-email" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddressId": 1,
    "subject": "Welcome!",
    "content": "Thank you for being a valued customer."
  }'
```

### Email with Attachment

```bash
curl -X POST "https://your-functions-app.azurecontainerapps.io/api/customers/1/send-email" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddressId": 1,
    "subject": "Your Receipt",
    "content": "Please find your receipt attached.",
    "attachmentUrl": "https://storage.blob.core.windows.net/adventureworks-receipts/receipt-123.pdf"
  }'
```

## Testing

Use the included test script:

```bash
./test-send-email.sh
```

## Response Codes

- **200 OK**: Email sent successfully
- **400 Bad Request**: Invalid request or email doesn't belong to customer
- **500 Internal Server Error**: Server error during email sending

## Integration Example

Integrate with receipt generation:

```csharp
// After generating receipt PDF in GenerateOrderReceipts function
var receiptUrl = "https://storage.blob.core.windows.net/adventureworks-receipts/receipt-{orderId}.pdf";

// Get the customer's primary email address ID from the database
var emailAddressId = await GetCustomerPrimaryEmailAddressIdAsync(customerId);

await httpClient.PostAsJsonAsync(
    $"api/customers/{customerId}/send-email",
    new {
        emailAddressId = emailAddressId,
        subject = $"Your Order #{orderId} Receipt",
        content = "Thank you for your order! Your receipt is attached.",
        attachmentUrl = receiptUrl
    });
```

## Sender Address

Emails are sent from: `DoNotReply@{EMAIL_SENDER_DOMAIN}`

The domain is automatically provisioned as an Azure-managed domain during infrastructure deployment.
