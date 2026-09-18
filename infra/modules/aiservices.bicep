param name string = 'av-ai-${uniqueString(resourceGroup().id)}'
param location string = 'canadaeast'
param tags object = {}
@description('The custom subdomain name used to access the API. Defaults to the value of the name parameter.')
param customSubDomainName string = name
param kind string = 'AIServices'
param restoreOpenAi bool = false
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param aadAdminObjectId string
param skipLocalDevRoleAssignments bool = false
param projectName string
param appInsightsId string
param appInsightConnectionString string
param appInsightConnectionName string
param aoaiConnectionName string
param storageAccountName string
param storageAccountConnectionName string

@allowed([ 'Enabled', 'Disabled' ])
param publicNetworkAccess string = 'Enabled'
param sku object = {
  name: 'S0'
}

param allowedIpRules array = []
param networkAcls object = empty(allowedIpRules) ? {
  defaultAction: 'Allow'
} : {
  ipRules: allowedIpRules
  defaultAction: 'Deny'
}
param embeddingModelName string = 'embedding'
param embeddingDeploymentName string = ''
param embeddingDeploymentVersion string = ''
param embeddingDeploymentCapacity int = 0
param embeddingSkuName string = ''
param imageModelName string = ''
param imageDeploymentName string = 'gpt-image-2'
param imageDeploymentVersion string = ''
param imageDeploymentCapacity int = 0
param imageSkuName string = ''
param imageModelFormat string = 'OpenAI'
var embedding = {
  modelName: !empty(embeddingModelName) ? embeddingModelName : 'text-embedding-ada-002'
  deploymentName: !empty(embeddingDeploymentName) ? embeddingDeploymentName : 'embedding'
  deploymentVersion: !empty(embeddingDeploymentVersion) ? embeddingDeploymentVersion : '2'
  deploymentCapacity: embeddingDeploymentCapacity != 0 ? embeddingDeploymentCapacity : 30
  embeddingSkuName: !empty(embeddingSkuName) ? embeddingSkuName : 'Standard'
}
var imageModel = {
  modelName: !empty(imageModelName) ? imageModelName : ''
  deploymentName: !empty(imageDeploymentName) ? imageDeploymentName : 'image'
  deploymentVersion: !empty(imageDeploymentVersion) ? string(imageDeploymentVersion) : ''
  deploymentCapacity: imageDeploymentCapacity != 0 ? imageDeploymentCapacity : 1
  imageSkuName: !empty(imageSkuName) ? imageSkuName : 'Standard'
  format: !empty(imageModelFormat) ? imageModelFormat : 'OpenAI'
}
param openAiHost string = 'azure'
param chatGptModelName string = ''
param chatGptDeploymentName string = 'chat'
param chatGptDeploymentVersion string = ''
param chatGptDeploymentCapacity int = 0
param chatGptSkuName string = ''
var chatGpt = {
  modelName: !empty(chatGptModelName) ? chatGptModelName : startsWith(openAiHost, 'azure') ? 'gpt-35-turbo' : 'gpt-3.5-turbo'
  deploymentName: !empty(chatGptDeploymentName) ? chatGptDeploymentName : 'chat'
  deploymentVersion: !empty(chatGptDeploymentVersion) ? chatGptDeploymentVersion : '0613'
  deploymentCapacity: chatGptDeploymentCapacity != 0 ? chatGptDeploymentCapacity : 30
  skuName: !empty(chatGptSkuName) ? chatGptSkuName : 'Standard'
}

var deployments = [
  {
    name: chatGpt.deploymentName
    model: {
      format: 'OpenAI'
      name: chatGpt.modelName
      version: chatGpt.deploymentVersion
    }
    sku: {
      name: chatGpt.skuName
      capacity: chatGpt.deploymentCapacity
    }
  }
  {
    name: embedding.deploymentName
    model: {
      format: 'OpenAI'
      name: embedding.modelName
      version: embedding.deploymentVersion
    }
    sku: {
      name: embedding.embeddingSkuName
      capacity: embedding.deploymentCapacity
    }
  }
]

var imageDeployment = !empty(imageModel.modelName) && !empty(imageModel.deploymentVersion) ? [
  {
    name: imageModel.deploymentName
    model: {
      format: imageModel.format
      name: imageModel.modelName
      version: imageModel.deploymentVersion
    }
    sku: {
      name: imageModel.imageSkuName
      capacity: imageModel.deploymentCapacity
    }
  }
] : []

var allDeployments = concat(deployments, imageDeployment)

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2022-09-01' existing = {
  name: storageAccountName
}

// Microsoft Foundry resource (AIServices kind enables access to broader model catalog, agents, and Foundry Tools)
// Uses latest 2025-06-01 API with allowProjectManagement for full Foundry capabilities
// defaultProject enables the "New Foundry" portal experience by designating the default project
// SystemAssigned identity is required alongside UserAssigned so Foundry can manage its internal
// Key Vault workspace identity — needed for ApiKey-type project connections (e.g. AppInsights tracing).
resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  kind: kind
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  properties: {
    customSubDomainName: customSubDomainName
    publicNetworkAccess: publicNetworkAccess
    networkAcls: networkAcls
    disableLocalAuth: true // Enforce Entra ID authentication only
    dynamicThrottlingEnabled: false
    restrictOutboundNetworkAccess: false
    restore: restoreOpenAi
    allowProjectManagement: true // Required for Microsoft Foundry features (projects, agents, broader model catalog)
    defaultProject: projectName // Sets the default Foundry project, enabling the New Foundry portal experience
  }
  sku: sku
}

// Connections are scoped to the project so they are isolated per-project rather than shared at
// the account level. Project-scoped connections are visible only within this project's context.
resource aiServiceConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  name: aoaiConnectionName
  parent: aiProject
  properties: {
    category: 'AzureOpenAI'
    authType: 'AAD'
    isSharedToAll: true
    target: account.properties.endpoints['OpenAI Language Model Instance API']
    metadata: {
      ApiType: 'azure'
      ResourceId: account.id
    }
  }
}

// Creates the Azure Foundry connection to your Azure Storage resource, scoped to the project
resource storageAccountConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  name: storageAccountConnectionName
  parent: aiProject
  properties: {
    category: 'AzureStorageAccount'
    target: storageAccount.properties.primaryEndpoints.blob
    authType: 'AAD'
    isSharedToAll: true    
    metadata: {
      ApiType: 'Azure'
      ResourceId: storageAccount.id
    }
  }
}

// Connects the Foundry resource to Application Insights for the portal Tracing experience.
// Must be at the ACCOUNT level (not project) per Microsoft docs: "Associate a resource once per Foundry resource"
// so tracing is available in all projects within the resource.
// Requires the account to have a SystemAssigned identity so Foundry can store the ApiKey in
// its internally managed Key Vault workspace identity.
// Reference: https://github.com/microsoft-foundry/foundry-samples/blob/main/infrastructure/infrastructure-setup-bicep/01-connections/connection-application-insights.bicep
resource appInsightsConnection 'Microsoft.CognitiveServices/accounts/connections@2025-06-01' = {
  name: appInsightConnectionName
  parent: account
  properties: {
    category: 'AppInsights'
    authType: 'ApiKey'
    isSharedToAll: true
    target: appInsightsId
    credentials: {
      key: appInsightConnectionString
    }
    metadata: {
      ApiType: 'Azure'
      ResourceId: appInsightsId
    }
  }
}

// Microsoft Foundry Project (organizes work, provides access management and data isolation)
// Projects are containers for agents, model deployments, and other Foundry resources
resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  name: projectName
  parent: account
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  properties: {
    description: 'AI Foundry Project for AI Foundry Demo'
    displayName: 'AI Foundry Demo Project'
  }
}

// Grant the managed identity data-plane permissions to invoke Microsoft Foundry deployments
// Role: Cognitive Services OpenAI Contributor - allows both inference and deployment management
// This role works with all Microsoft Foundry models (OpenAI, Meta, Mistral, etc.) not just OpenAI
// For inference-only access, use 'Cognitive Services OpenAI User' (5e0bd9bd-7b93-4f28-af87-19fc36ad61bd)
resource openAiUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  // Use deterministic GUID from account id + identity id + role definition
  name: guid(account.id, azidentity.id, 'a001fd3d-188f-4b5d-821b-7da978bf7442')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a001fd3d-188f-4b5d-821b-7da978bf7442') // Cognitive Services OpenAI Contributor
    principalId: azidentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the managed identity Azure AI Developer role for Foundry Agents API access
// Required for: reading agent definitions (agents/read), invoking agents, and using the Responses API with MCP tools
// Role: Azure AI Developer (64702f94-c441-49e6-a78b-ef80e0188fee)
// Without this role, the Container App cannot call GET /api/projects/{name}/agents/{agentId}
resource aiDeveloperRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(account.id, azidentity.id, '64702f94-c441-49e6-a78b-ef80e0188fee')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '64702f94-c441-49e6-a78b-ef80e0188fee') // Azure AI Developer
    principalId: azidentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the same Azure AI Developer role to local devs for testing with az login
resource aiDeveloperLocalRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments) {
  name: guid(account.id, aadAdminObjectId, '64702f94-c441-49e6-a78b-ef80e0188fee')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '64702f94-c441-49e6-a78b-ef80e0188fee') // Azure AI Developer
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// Grant the specified Entra ID admin/user data-plane access for local development
// Enables DefaultAzureCredential (az login) to call Microsoft Foundry deployments during development
// Uses deterministic GUID to maintain idempotency across deployments
resource openAiUserLocalRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments) {
  name: guid(account.id, aadAdminObjectId, 'a001fd3d-188f-4b5d-821b-7da978bf7442')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a001fd3d-188f-4b5d-821b-7da978bf7442') // Cognitive Services OpenAI Contributor
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// ── Project-scoped role assignments ──────────────────────────────────────────
// The Agents data-plane API (AIServices/agents/write) requires roles at the project scope.
// Account-level roles do NOT cascade to project data-plane operations.

// Grant Azure AI Developer on the project to the managed identity (for runtime agent invocation)
resource aiDeveloperProjectRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(aiProject.id, azidentity.id, '64702f94-c441-49e6-a78b-ef80e0188fee')
  scope: aiProject
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '64702f94-c441-49e6-a78b-ef80e0188fee') // Azure AI Developer
    principalId: azidentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant Azure AI Developer on the project to the local dev user (for agent creation scripts)
resource aiDeveloperLocalProjectRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments) {
  name: guid(aiProject.id, aadAdminObjectId, '64702f94-c441-49e6-a78b-ef80e0188fee')
  scope: aiProject
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '64702f94-c441-49e6-a78b-ef80e0188fee') // Azure AI Developer
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// Grant Cognitive Services OpenAI Contributor on the project to the local dev user
resource openAiUserLocalProjectRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments) {
  name: guid(aiProject.id, aadAdminObjectId, 'a001fd3d-188f-4b5d-821b-7da978bf7442')
  scope: aiProject
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a001fd3d-188f-4b5d-821b-7da978bf7442') // Cognitive Services OpenAI Contributor
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// ── Custom role: AIServices data-plane access ────────────────────────────────
// The built-in "Azure AI Developer" role does NOT include the AIServices/* data actions
// needed for agent creation, invocation, and memory store operations.
// This custom role grants the broad AIServices/* data action at the subscription level.
resource foundryAgentsRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'foundry-agents-data-role')
  properties: {
    roleName: 'AdventureWorks Foundry Agents ${uniqueString(resourceGroup().id)}'
    description: 'Grants full AIServices data-plane access for Azure AI Foundry agents, memory stores, and related operations.'
    type: 'CustomRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.CognitiveServices/accounts/AIServices/*'
        ]
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscriptionResourceId('Microsoft.Resources/resourceGroups', resourceGroup().name)
    ]
  }
}

// Assign the custom AIServices role to the managed identity at project scope
resource foundryAgentsProjectMiRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(aiProject.id, azidentity.id, 'foundry-agents-data-role')
  scope: aiProject
  properties: {
    roleDefinitionId: foundryAgentsRoleDefinition.id
    principalId: azidentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Assign the custom AIServices role to the local dev user at project scope
resource foundryAgentsProjectUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments) {
  name: guid(aiProject.id, aadAdminObjectId, 'foundry-agents-data-role')
  scope: aiProject
  properties: {
    roleDefinitionId: foundryAgentsRoleDefinition.id
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// Deploy models to Microsoft Foundry resource using latest API
// Models deployed here are accessible via Azure AI Model Inference API endpoint
// dependsOn aiProject: project creation writes to the parent account's ETag; without this
// dependency, concurrent project + deployment operations cause IfMatchPreconditionFailed.
@batchSize(1)
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [for deployment in allDeployments: {
  parent: account
  name: deployment.name
  properties: {
    model: deployment.model
  }
  sku: deployment.sku
  dependsOn: [aiProject]
}]

output endpoint string = account.properties.endpoint
output id string = account.id
output name string = account.name
output projectResourceId string = aiProject.id
output projectName string = aiProject.name
output serviceName string = account.name
output projectEndpoint string = aiProject.properties.endpoints['AI Foundry API']
output PrincipalId string = azidentity.properties.principalId
output accountPrincipalId string = azidentity.properties.principalId
output projectPrincipalId string = azidentity.properties.principalId
output storageConnectionId string = storageAccountConnection.id
output storageConnectionName string = storageAccountConnection.name
