param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param seedJobName string = 'av-seed-job-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param containerAppEnvId string
param bootstrapImage string = 'mcr.microsoft.com/azure-powershell:latest'
param sqlServerName string
param sqlDatabaseName string

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource seedJob 'Microsoft.App/jobs@2024-03-01' = {
  name: seedJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'seed-job'
  }
  properties: {
    environmentId: containerAppEnvId
    configuration: {
      secrets: []
      registries: [
        {
          identity: azidentity.id
          server: acr.properties.loginServer
        }
      ]
    }
    template: {
      containers: [
        {
          name: seedJobName
          image: bootstrapImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'SQL_SERVER_NAME'
              value: sqlServerName
            }
            {
              name: 'SQL_DATABASE_NAME'
              value: sqlDatabaseName
            }
            {
              name: 'USER_MANAGED_IDENTITY_NAME'
              value: identityName
            }
            {
              name: 'TENANT_ID'
              value: subscription().tenantId
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: azidentity.properties.clientId
            }
          ]
        }
      ]
    }
  }
}

output seedJobName string = seedJob.name
output seedJobId string = seedJob.id
