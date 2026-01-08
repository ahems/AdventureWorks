# Azure Communication Service Email Domain Linking

## What Was Implemented

The Communication Service now automatically links the Azure-managed email domain during deployment using Bicep.

## Bicep Implementation

```bicep
resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationServiceName
  location: 'global'
  properties: {
    dataLocation: dataLocation
    linkedDomains: [
      emailDomain.id  // Links the email domain resource
    ]
  }
  dependsOn: [
    emailDomain  // Ensures domain is created first
  ]
}
```

## Why This Is Important

Without linking the domain, the Communication Service cannot send emails even though both resources exist. The `linkedDomains` property creates the association needed for email functionality.

## Verification

After deployment, verify the link:

```bash
az communication show \
  --name <communication-service-name> \
  --resource-group <resource-group> \
  --query "linkedDomains"
```

Should return:

```json
[
  "/subscriptions/.../Microsoft.Communication/emailServices/.../domains/AzureManagedDomain"
]
```

## Alternative: Manual Linking

If you need to link manually via Azure CLI:

```bash
DOMAIN_ID=$(az communication email domain show \
  --name AzureManagedDomain \
  --email-service-name <email-service-name> \
  --resource-group <resource-group> \
  --query id -o tsv)

az communication update \
  --name <communication-service-name> \
  --resource-group <resource-group> \
  --linked-domains "$DOMAIN_ID"
```

## Testing Email Functionality

Once linked, test sending emails:

```bash
curl -X POST "https://<function-app-url>/api/customers/{customerId}/send-email" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddressId": <email-address-id>,
    "subject": "Test Email",
    "content": "This is a test email with HTML styling."
  }'
```

## Permissions Required

The managed identity needs **Contributor** role on the Communication Service (already configured in Bicep).
