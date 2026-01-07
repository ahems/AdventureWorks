# Receipt Generation - Troubleshooting Queue Error

## ❌ Error: "The specified queue does not exist"

If you see this error:

```
404 The specified queue does not exist.
x-ms-error-code:QueueNotFound
```

This means the Azure Storage Queue `order-receipt-generation` hasn't been created yet, and the Function's Managed Identity doesn't have permission to create it automatically.

## ✅ Quick Fix

Run the setup script to create the queue and assign permissions:

### Option 1: Bash (Linux/Mac/WSL)

```bash
./setup-receipt-queue.sh
```

### Option 2: PowerShell (Windows)

```powershell
.\setup-receipt-queue.ps1
```

### Option 3: Manual Azure CLI Commands

If the scripts don't work, run these commands manually:

```bash
# 1. Get your values from azd
STORAGE_ACCOUNT=$(azd env get-values | grep AZURE_STORAGE_ACCOUNT_NAME | cut -d'=' -f2 | tr -d '"')
RESOURCE_GROUP=$(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d'=' -f2 | tr -d '"')
FUNCTION_APP=$(azd env get-values | grep AZURE_FUNCTION_APP_NAME | cut -d'=' -f2 | tr -d '"')

# 2. Create the queue
az storage queue create \
    --name "order-receipt-generation" \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login

# 3. Get the Function's Managed Identity Principal ID
PRINCIPAL_ID=$(az functionapp identity show \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --query principalId -o tsv)

# 4. Get Storage Account resource ID
STORAGE_ID=$(az storage account show \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --query id -o tsv)

# 5. Assign the "Storage Queue Data Contributor" role
az role assignment create \
    --assignee "$PRINCIPAL_ID" \
    --role "Storage Queue Data Contributor" \
    --scope "$STORAGE_ID"
```

### Option 4: Azure Portal (Manual)

1. **Create the Queue:**

   - Go to Azure Portal
   - Navigate to your Storage Account
   - Click "Queues" in the left menu
   - Click "+ Queue"
   - Name: `order-receipt-generation`
   - Click "OK"

2. **Assign Permissions:**
   - Still in your Storage Account
   - Click "Access Control (IAM)" in the left menu
   - Click "+ Add" → "Add role assignment"
   - Role: **Storage Queue Data Contributor**
   - Assign access to: **Managed Identity**
   - Members: Select your Function App's managed identity
   - Click "Review + assign"

## 🔍 Verify the Fix

After running the setup, test the function again:

```bash
FUNCTION_URL=$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '"')

curl -X POST "$FUNCTION_URL/api/GenerateOrderReceipts_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO75125"]}'
```

You should now get a successful response:

```json
{
  "message": "Successfully enqueued 1 receipt generation job(s)",
  "enqueuedOrders": ["SO75125"],
  "totalEnqueued": 1
}
```

## 📊 Check Queue Status

Verify the queue is working:

```bash
# List queues
az storage queue list \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login \
    --query "[].name"

# Check queue length (should show messages if function is processing)
az storage queue metadata show \
    --name "order-receipt-generation" \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login
```

## 🔧 Why This Happens

The function code includes `CreateIfNotExistsAsync()` which _should_ create the queue automatically, but this requires the Managed Identity to have the **Storage Queue Data Contributor** role at the Storage Account level.

During initial deployment with `azd up`, this role may not be assigned automatically. The setup scripts fix this by:

1. Creating the queue manually (with your user credentials)
2. Ensuring the Function App has a system-assigned Managed Identity
3. Assigning the proper role to that identity

## 🚀 Future Deployments

After running the setup once, future deployments should work without issues because:

- The queue will continue to exist
- The role assignment persists across deployments

## ⚠️ Still Having Issues?

### Check Managed Identity

```bash
# Verify the Function App has a Managed Identity
az functionapp identity show \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP"
```

### Check Role Assignments

```bash
# List all role assignments for the Function's identity
az role assignment list \
    --assignee "$PRINCIPAL_ID" \
    --all
```

### Check Function Logs

View the Azure Function logs in real-time:

```bash
az functionapp log tail \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP"
```

Or in the Azure Portal:

1. Navigate to your Function App
2. Click "Log stream" in the left menu
3. Watch for error messages when you trigger the function

## 📝 Other Possible Issues

### Issue: "Order not found"

**Cause:** The SalesOrderNumber doesn't exist in the database  
**Fix:** Query valid order numbers:

```sql
SELECT TOP 10 SalesOrderNumber, OrderDate, TotalDue
FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC
```

### Issue: "Container not found"

**Cause:** The blob container `adventureworks-receipts` doesn't exist  
**Fix:** The code should create it automatically, but you can create it manually:

```bash
az storage container create \
    --name "adventureworks-receipts" \
    --account-name "$STORAGE_ACCOUNT" \
    --public-access blob \
    --auth-mode login
```

### Issue: Function not responding at all

**Cause:** Function may not be deployed or has startup errors  
**Fix:**

```bash
# Check deployment status
az functionapp show \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --query state

# Restart the function
az functionapp restart \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP"
```

## 📚 Related Documentation

- [RECEIPT_GENERATION.md](api-functions/RECEIPT_GENERATION.md) - Complete feature documentation
- [RECEIPT_GENERATION_QUICKREF.md](RECEIPT_GENERATION_QUICKREF.md) - Quick reference
- [Azure Storage Queue Documentation](https://docs.microsoft.com/en-us/azure/storage/queues/)
- [Azure Managed Identity](https://docs.microsoft.com/en-us/azure/active-directory/managed-identities-azure-resources/)

## ✅ Success Indicators

You'll know it's working when you see:

1. ✅ HTTP response with 202 Accepted status
2. ✅ Response body shows "Successfully enqueued X receipt generation job(s)"
3. ✅ Function logs show "Enqueued receipt generation for order: SO75125"
4. ✅ Function logs show "Processing receipt generation for order: SO75125"
5. ✅ Function logs show "Successfully generated receipt... PDF available at: https://..."
6. ✅ PDF file appears in blob storage under `CustomerReceipts/SO75125.pdf`
