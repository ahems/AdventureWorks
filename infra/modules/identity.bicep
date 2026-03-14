param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

var roleName = 'av-deployment-script-role-${uniqueString(resourceGroup().id)}'
var roleDescription = 'Role to deploy custom CLI scripts for the AdventureWorks deployment'
var roleDefName = guid(identityName)
var managedIdentityOperatorRoleId  = 'f1a07417-d97a-45cb-824c-7a7467783830'

// Deploy User Assigned Identity directly (avoids AVM nested template that triggers azd preflight parse error on identity.userAssignedIdentities)
resource userAssignedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource avDeploymentScriptCustomRoleDefinition 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: roleDefName
  properties: {
    roleName: roleName
    description: roleDescription
    type: 'customRole'
    permissions: [
      {
        actions: [
          'Microsoft.Storage/storageAccounts/*','Microsoft.ContainerInstance/containerGroups/*','Microsoft.Resources/deployments/*','Microsoft.Resources/deploymentScripts/*'
        ]
      }
    ]
    assignableScopes: [
      resourceGroup().id
    ]
  }
}

resource managedIdentityOperatorRoleIdAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, identityName, managedIdentityOperatorRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', managedIdentityOperatorRoleId) // Managed Identity Operator role for deploying scripts
    principalId: userAssignedIdentity.properties.principalId
    principalType : 'ServicePrincipal'
  }
}

resource avDeploymentScriptCustomRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, identityName, roleDefName)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: avDeploymentScriptCustomRoleDefinition.id
    principalType: 'ServicePrincipal'
    principalId: userAssignedIdentity.properties.principalId
  }
}

output identityid string = userAssignedIdentity.id
output clientId string = userAssignedIdentity.properties.clientId
output principalId string = userAssignedIdentity.properties.principalId
