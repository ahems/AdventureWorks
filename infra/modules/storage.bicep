param storageName string = 'avstorage${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param identityId string
param aadAdminObjectId string
param virtualNetworkId string
param privateEndpointSubnetId string

var storageServices = [
  'blob'
  'queue'
  'table'
  'file'
]

var durableSettings = loadJsonContent('../../api-functions/host.json').extensions.durableTask
var durableHubName = durableSettings.hubName
var durableStoragePrefix = toLower(durableHubName)
var durablePartitionCount = union({ partitionCount: 4 }, durableSettings.storageProvider).partitionCount

var applicationQueueDescriptions = {
  'order-receipt-generation': 'Queue for generating PDF receipts for customer orders'
  'order-email-generation': 'Queue for sending order confirmation emails with receipt attachments'
  'ai-job-image-queue': 'Serial job queue for DALL-E image generation (one message at a time)'
  'ai-job-chat-queue': 'Serial job queue for GPT chat operations: translations and review generation'
  'ai-job-embeddings-queue': 'Serial job queue for text-embedding operations: product and review embeddings'
  'product-thumbnail-generation': 'Queue for generating product thumbnails from large images'
  'sales-order-status': 'Queue for tracking the status of sales orders'
  'production-wo-queue': 'Event-driven queue that drives the manufacturing simulation: each message represents one WorkOrder routing-operation phase'
  'supply-chain-orders-queue': 'Event-driven queue driving purchase order state transitions (placed-confirmed-picking-shipped-delivered) and vendor restock events'
  'simulation-order-queue': 'Autonomous order simulation queue: each message carries a CustomerId (0 = new customer) and optional PersonaHint. The AI agent generates a realistic order for the specified customer or persona.'
  'warehouse-ops-queue': 'Event-driven queue driving the warehouse simulation: each message represents one store/retrieve/receive operation phase for a warehouse worker at Finished Goods Storage (LocationID 7)'
  'review-moderation-queue': 'Background queue for review auto-moderation: analyze pending unreplied reviews with AI, create staff reply, and approve.'
  'manufacturing-agent-queue': 'Queue for manufacturing AI agent invocations triggered by new sales orders'
  'auto-promotion-queue': 'Queue for automatic AI promotion generation triggered by order volume thresholds'
  'utility-status-queue': 'Bounded Durable utility status observers; messages stop when the registered instance is terminal'
}

var applicationQueues = [for queue in items(applicationQueueDescriptions): {
  name: queue.key
  metadata: {
    description: queue.value
  }
}]

var poisonQueues = [for queue in items(applicationQueueDescriptions): {
  name: '${queue.key}-poison'
}]

var durableControlQueues = [for partition in range(0, durablePartitionCount): {
  name: '${durableStoragePrefix}-control-${padLeft(partition, 2, '0')}'
}]

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
    publicNetworkAccess: 'Disabled'
    requireInfrastructureEncryption: true
    accessTier: 'Cool'
    networkAcls: {
      defaultAction: 'Deny'
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
        {
          name: 'function-releases'
          publicAccess: 'None'
          metadata: {
            description: 'Deployment packages for Flex Consumption function app'
          }
        }
        {
          name: '${durableStoragePrefix}-leases'
          publicAccess: 'None'
        }
        {
          name: '${durableStoragePrefix}-applease'
          publicAccess: 'None'
        }
        {
          name: '${durableStoragePrefix}-largemessages'
          publicAccess: 'None'
        }
      ]
    }
    
    queueServices: {
      queues: concat(
        applicationQueues,
        poisonQueues,
        durableControlQueues,
        [
          {
            name: '${durableStoragePrefix}-workitems'
          }
        ]
      )
    }

    tableServices: {
      tables: [
        {
          name: 'shoppingSimulator'
        }
        {
          name: 'awOrderPipelineConfig'
        }
        {
          name: 'awSupplyChain'
        }
        {
          name: 'awManufacturing'
        }
        {
          name: 'awBankAccounts'
        }
        {
          name: 'awBankTransactions'
        }
        {
          name: 'awWarehouse'
        }
        {
          name: 'awManufacturingAgentConfig'
        }
        {
          name: 'awManufacturingAgentRuns'
        }
        {
          name: 'awManufacturingProposals'
        }
        {
          name: 'verifiedReviewsJob'
        }
        {
          name: 'reviewModerationJob'
        }
        {
          name: 'awAutoPromotionConfig'
        }
        {
          name: 'awMcpTasks'
        }
        {
          name: '${durableHubName}History'
        }
        {
          name: '${durableHubName}Instances'
        }
        {
          name: '${durableHubName}Partitions'
        }
        {
          name: 'AzureFunctionsDiagnosticEvents'
        }
      ]
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
        roleDefinitionIdOrName: 'Storage Blob Data Owner'
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
      // REST API (ShareTokenIntent.Backup) requires Privileged Reader; SMB Share Reader is SMB-only
      {
        principalId: identityId
        roleDefinitionIdOrName: 'Storage File Data Privileged Reader'
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

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for service in storageServices: {
  name: 'privatelink.${service}.${environment().suffixes.storage}'
  location: 'global'
}]

resource privateDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (service, index) in storageServices: {
  name: '${privateDnsZones[index].name}/${storageName}-${service}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetworkId
    }
  }
}]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for service in storageServices: {
  name: '${storageName}-${service}-private-endpoint'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${storageName}-${service}-private-link'
        properties: {
          privateLinkServiceId: storageAccount.outputs.resourceId
          groupIds: [
            service
          ]
        }
      }
    ]
  }
  dependsOn: [
    privateDnsZoneLinks
  ]
}]

resource privateDnsZoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (service, index) in storageServices: {
  name: '${privateEndpoints[index].name}/default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: service
        properties: {
          privateDnsZoneId: privateDnsZones[index].id
        }
      }
    ]
  }
}]

output storageAccountName string = storageAccount.outputs.name
output storageAccountId string = storageAccount.outputs.resourceId
