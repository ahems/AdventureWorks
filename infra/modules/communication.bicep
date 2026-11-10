param communicationServiceName string = 'av-comms-${uniqueString(resourceGroup().id)}'
param identityName string
param aadAdminObjectId string
param dataLocation string = 'United States' // Email service data location
param workspaceName string

// Get reference to existing managed identity
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// Create Communication Service
resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationServiceName
  location: 'global'
  properties: {
    dataLocation: dataLocation
    linkedDomains: [
      emailDomain.id
    ]
  }
}

resource emailSenderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'AdventureWorks Email Sender')
  properties: {
    roleName: 'AdventureWorks Email Sender ${uniqueString(resourceGroup().id)}'
    description: 'Runtime email authorization without resource deletion, access keys or role assignment permissions.'
    type: 'customRole'
    permissions: [
      {
        actions: [
          'Microsoft.Communication/communicationServices/read'
          'Microsoft.Communication/communicationServices/write'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      communicationService.id
    ]
  }
}

resource communicationServiceRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(communicationService.id, identity.id, 'AdventureWorks Email Sender')
  scope: communicationService
  properties: {
    roleDefinitionId: emailSenderRole.id
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant admin Contributor role for Communication Service access
resource communicationServiceAdminRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(communicationService.id, aadAdminObjectId, 'Contributor')
  scope: communicationService
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c') // Contributor
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// Email service requires a domain - using AzureManagedDomain for quick setup
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: '${communicationServiceName}-email'
  location: 'global'
  properties: {
    dataLocation: dataLocation
  }
}

// Create Azure-managed email domain (*.azurecomm.net)
resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
  }
}

// Reference to Log Analytics workspace
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

// Diagnostic settings for Communication Service metrics only (log categories not supported)
resource communicationDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'email-diagnostics'
  scope: communicationService
  properties: {
    workspaceId: workspace.id
    logs: []
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

// Outputs needed for application configuration
output communicationServiceName string = communicationService.name
output communicationServiceResourceId string = communicationService.id
output communicationServiceEndpoint string = 'https://${communicationService.name}.communication.azure.com'
output emailServiceName string = emailService.name
output emailServiceResourceId string = emailService.id

// Domain information for sending emails
output senderDomain string = emailDomain.properties.mailFromSenderDomain
