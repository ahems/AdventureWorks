param appName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param workspaceName string = 'av-workspace-${toLower(uniqueString(resourceGroup().id))}'
param location string = resourceGroup().location
param identityName string = ''
param aadAdminObjectId string = ''
@allowed([ 'User', 'ServicePrincipal' ])
param deployerPrincipalType string = 'User'
param skipLocalDevRoleAssignments bool = false

// Use Azure Verified Module for Log Analytics Workspace
module workspace 'br/public:avm/res/operational-insights/workspace:0.12.0' = {
  name: 'log-analytics-workspace-${workspaceName}'
  params: {
    name: workspaceName
    location: location
    skuName: 'PerGB2018'
    dataRetention: 30
    dailyQuotaGb: 1
  }
}

// Use Azure Verified Module for Application Insights
module appInsights 'br/public:avm/res/insights/component:0.4.1' = {
  name: 'app-insights-${appName}'
  params: {
    name: appName
    location: location
    kind: 'web'
    applicationType: 'web'
    workspaceResourceId: workspace.outputs.resourceId
    disableLocalAuth: false
  }
}

// Reference the deployed App Insights resource for role assignment scoping
resource appInsightsResource 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appName
}

resource workspaceResource 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource workspaceMonitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(identityName)) {
  name: guid(workspaceResource.id, identityName, '73c42c96-874c-492b-b04d-ab87d138a893')
  scope: workspaceResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: azidentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [workspace]
}

// Reference the user-assigned managed identity used by AI Foundry
resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(identityName)) {
  name: identityName
}

// Grant the AI Foundry managed identity Reader on Application Insights for trace access
resource appInsightsReaderRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!empty(identityName)) {
  name: guid(appInsightsResource.id, identityName, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  scope: appInsightsResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7') // Reader
    principalId: azidentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [appInsights]
}

// Grant the configured deployer principal Reader on Application Insights for trace access
resource appInsightsReaderLocalRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (!skipLocalDevRoleAssignments && !empty(aadAdminObjectId)) {
  name: guid(appInsightsResource.id, aadAdminObjectId, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  scope: appInsightsResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7') // Reader
    principalId: aadAdminObjectId
    principalType: deployerPrincipalType
  }
  dependsOn: [appInsights]
}

output resourceId string = appInsights.outputs.resourceId
output instrumentationKey string = appInsights.outputs.instrumentationKey
output connectionString string = appInsights.outputs.connectionString
output name string = appInsights.outputs.name
output workspaceResourceId string = workspace.outputs.resourceId
output workspaceCustomerId string = workspace.outputs.logAnalyticsWorkspaceId
