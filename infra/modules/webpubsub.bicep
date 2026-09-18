param webPubSubName string
param location string = resourceGroup().location
param identityName string

// Get reference to existing managed identity
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// Create Web PubSub (Free tier — 20 concurrent connections, 20K msgs/day)
resource webPubSub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: webPubSubName
  location: location
  sku: {
    name: 'Free_F1'
    tier: 'Free'
    capacity: 1
  }
  properties: {
    tls: {
      clientCertEnabled: false
    }
    publicNetworkAccess: 'Enabled'
  }
}

// Grant managed identity "Web PubSub Service Owner" role
// This allows api-functions to generate client tokens and send messages via Managed Identity
resource webPubSubRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webPubSub.id, identity.id, '12cf5a90-567b-43ae-8102-96cf46c7d9b4')
  scope: webPubSub
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12cf5a90-567b-43ae-8102-96cf46c7d9b4') // Web PubSub Service Owner
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output webPubSubHostName string = webPubSub.properties.hostName
output webPubSubId string = webPubSub.id
output webPubSubName string = webPubSub.name
