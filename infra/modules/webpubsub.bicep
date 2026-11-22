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
    disableLocalAuth: true
    disableAadAuth: false
    tls: {
      clientCertEnabled: false
    }
    publicNetworkAccess: 'Enabled'
  }
}

resource webPubSubRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webPubSub.id, identity.id, '12cf5a90-567b-43ae-8102-96cf46c7d9b4')
  scope: webPubSub
  properties: {
    // Built-in Service Owner (WebPubSub/*) at this resource only. The runtime needs group/send and
    // clientConnection/generateToken; Service Reader grants neither and a custom role would need
    // roleDefinitions/write, which the ABAC-conditioned deployer lacks (see infra/README.md).
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12cf5a90-567b-43ae-8102-96cf46c7d9b4')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output webPubSubHostName string = webPubSub.properties.hostName
output webPubSubId string = webPubSub.id
output webPubSubName string = webPubSub.name
