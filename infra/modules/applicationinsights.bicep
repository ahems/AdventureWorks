param appName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param workspaceName string = 'av-workspace-${toLower(uniqueString(resourceGroup().id))}'
param location string = resourceGroup().location

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

output resourceId string = appInsights.outputs.resourceId
output instrumentationKey string = appInsights.outputs.instrumentationKey
output connectionString string = appInsights.outputs.connectionString
output name string = appInsights.outputs.name
