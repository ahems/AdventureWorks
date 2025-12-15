param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

var roleName = 'av-deployment-script-role'
var roleDescription = 'Role to deploy custom CLI scripts for the AdventureWorks deployment'
var roleDefName = guid(identityName)
var managedIdentityOperatorRoleId  = 'f1a07417-d97a-45cb-824c-7a7467783830'

// Use Azure Verified Module for User Assigned Identity
module azidentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.4.2' = {
  name: 'user-assigned-identity-${identityName}'
  params: {
    name: identityName
    location: location
  }
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
  name: guid('managedIdentityOperatorRoleIdAssignment-${uniqueString(resourceGroup().id)}')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', managedIdentityOperatorRoleId) // Managed Identity Operator role for deploying scripts
    principalId: azidentity.outputs.principalId
    principalType : 'ServicePrincipal'
  }
}

resource avDeploymentScriptCustomRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('avDeploymentScriptCustomRoleAssignment-${uniqueString(resourceGroup().id)}')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: avDeploymentScriptCustomRoleDefinition.id
    principalType: 'ServicePrincipal'
    principalId: azidentity.outputs.principalId
  }
}

output identityid string = azidentity.outputs.resourceId
output clientId string = azidentity.outputs.clientId
output principalId string = azidentity.outputs.principalId
