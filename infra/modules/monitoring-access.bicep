param identityPrincipalId string
param sqlServerName string
param sqlDatabaseName string
param storageAccountName string
param functionsName string
param dabName string
param mcpName string
param webPubSubName string
param foundryName string
param keyVaultName string

var readerRole = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
resource sql 'Microsoft.Sql/servers/databases@2023-08-01' existing = {
  name: '${sqlServerName}/${sqlDatabaseName}'
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource functions 'Microsoft.Web/sites@2023-12-01' existing = { name: functionsName }
resource dab 'Microsoft.App/containerApps@2024-03-01' existing = { name: dabName }
resource mcp 'Microsoft.App/containerApps@2024-03-01' existing = { name: mcpName }
resource wps 'Microsoft.SignalRService/webPubSub@2024-03-01' existing = { name: webPubSubName }
resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: foundryName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource sqlReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sql.id, identityPrincipalId, readerRole)
  scope: sql
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource storageReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identityPrincipalId, readerRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource functionsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functions.id, identityPrincipalId, readerRole)
  scope: functions
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource dabReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dab.id, identityPrincipalId, readerRole)
  scope: dab
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource mcpReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(mcp.id, identityPrincipalId, readerRole)
  scope: mcp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource wpsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(wps.id, identityPrincipalId, readerRole)
  scope: wps
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource foundryReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identityPrincipalId, readerRole)
  scope: foundry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identityPrincipalId, readerRole)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
