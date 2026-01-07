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
    allowSharedKeyAccess: false // RBAC only
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    requireInfrastructureEncryption: true
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
          publicAccess: 'Blob'
          metadata: {
            description: 'Public container for customer order receipt PDFs'
          }
        }
        {
          name: 'locales'
          publicAccess: 'Blob'
          metadata: {
            description: 'Public container for translated language files'
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
      ]
    }
    
    tableServices: {
      tables: []
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
    ]
  }
}

output storageAccountName string = storageAccount.outputs.name
output storageAccountId string = storageAccount.outputs.resourceId
