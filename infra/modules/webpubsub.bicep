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

resource webPubSubRuntimeRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'AdventureWorks Web PubSub Runtime')
  properties: {
    roleName: 'AdventureWorks Web PubSub Runtime ${uniqueString(resourceGroup().id)}'
    description: 'Issue client capabilities and publish or inspect groups for the selected Web PubSub resource.'
    type: 'customRole'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.SignalRService/WebPubSub/clientConnection/generateToken/action'
          'Microsoft.SignalRService/WebPubSub/clientConnection/write'
          'Microsoft.SignalRService/WebPubSub/group/send/action'
          'Microsoft.SignalRService/WebPubSub/group/read'
        ]
        notDataActions: []
      }
    ]
    assignableScopes: [
      webPubSub.id
    ]
  }
}

resource webPubSubRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webPubSub.id, identity.id, 'AdventureWorks Web PubSub Runtime')
  scope: webPubSub
  properties: {
    roleDefinitionId: webPubSubRuntimeRole.id
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output webPubSubHostName string = webPubSub.properties.hostName
output webPubSubId string = webPubSub.id
output webPubSubName string = webPubSub.name
