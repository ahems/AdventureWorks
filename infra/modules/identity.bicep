param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

// Deploy User Assigned Identity directly (avoids AVM nested template that triggers azd preflight parse error on identity.userAssignedIdentities)
resource userAssignedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

output identityid string = userAssignedIdentity.id
output clientId string = userAssignedIdentity.properties.clientId
output principalId string = userAssignedIdentity.properties.principalId
