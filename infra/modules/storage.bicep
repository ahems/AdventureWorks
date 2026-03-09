param storageName string = 'avstorage${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param identityId string
param aadAdminObjectId string

// Use Azure Verified Module for Storage Account
module storageAccount 'br/public:avm/res/storage/storage-account:0.16.0' = {
  name: 'storage-account-${storageName}'
  params: {
    name: storageName
    location: location
    kind: 'StorageV2'
    skuName: 'Standard_LRS'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // Required for Container Apps file share mounts
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    requireInfrastructureEncryption: true
    accessTier: 'Cool'
    networkAcls: {
      defaultAction: 'Allow'
    }
    
    // Enable services needed for Durable Functions
    blobServices: {
      containers: [
        {
          name: 'azure-webjobs-hosts'
          publicAccess: 'None'
          metadata: {
            description: 'Azure Functions host container for durable functions state'
          }
        }
        {
          name: 'azure-webjobs-secrets'
          publicAccess: 'None'
          metadata: {
            description: 'Azure Functions secrets container'
          }
        }
        {
          name: 'adventureworks-receipts'
          publicAccess: 'None'
          metadata: {
            description: 'Container for customer order receipt PDFs'
          }
        }
        {
          name: 'locales'
          publicAccess: 'None'
          metadata: {
            description: 'Container for translated language files'
          }
        }
      ]
    }
    
    queueServices: {
      queues: [
        {
          name: 'order-receipt-generation'
          metadata: {
            description: 'Queue for generating PDF receipts for customer orders'
          }
        }
        {
          name: 'order-email-generation'
          metadata: {
            description: 'Queue for sending order confirmation emails with receipt attachments'
          }
        }
        {
          name: 'product-image-generation'
          metadata: {
            description: 'Queue for generating AI product images'
          }
        }
        {
          name: 'product-thumbnail-generation'
          metadata: {
            description: 'Queue for generating product thumbnails from large images'
          }
        }
        {
          name: 'product-review-generation'
          metadata: {
            description: 'Queue for generating AI product reviews'
          }
        }
        {
          name: 'sales-order-status'
          metadata: {
            description: 'Queue for tracking the status of sales orders'
          }
        }
      ]
    }
    
    tableServices: {
      tables: []
    }
    
    fileServices: {
      shares: [
        {
          name: 'seed-job-logs'
          accessTier: 'TransactionOptimized'
          enabledProtocols: 'SMB'
          shareQuota: 5
        }
      ]
    }
    
    // Grant managed identity required permissions for Durable Functions
    roleAssignments: [
      {
        principalId: identityId
        roleDefinitionIdOrName: 'Storage Blob Data Contributor'
        principalType: 'ServicePrincipal'
      }
      {
        principalId: identityId
        roleDefinitionIdOrName: 'Storage Queue Data Contributor'
        principalType: 'ServicePrincipal'
      }
      {
        principalId: identityId
        roleDefinitionIdOrName: 'Storage Table Data Contributor'
        principalType: 'ServicePrincipal'
      }
      // Grant current user permissions for local development
      {
        principalId: aadAdminObjectId
        roleDefinitionIdOrName: 'Storage Blob Data Contributor'
        principalType: 'User'
      }
      {
        principalId: aadAdminObjectId
        roleDefinitionIdOrName: 'Storage Queue Data Contributor'
        principalType: 'User'
      }
      {
        principalId: aadAdminObjectId
        roleDefinitionIdOrName: 'Storage Table Data Contributor'
        principalType: 'User'
      }
      {
        principalId: aadAdminObjectId
        roleDefinitionIdOrName: 'Storage File Data SMB Share Contributor'
        principalType: 'User'
      }
    ]
  }
}

output storageAccountName string = storageAccount.outputs.name
output storageAccountId string = storageAccount.outputs.resourceId
