param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param seedJobName string = 'av-seed-job-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param seedIdentityName string
param containerAppEnvId string
param bootstrapImage string = 'mcr.microsoft.com/azure-powershell:latest'
param imageName string = ''
param sqlServerName string
param sqlDatabaseName string

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource seedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: seedIdentityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource seedAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, seedIdentity.id, 'AcrPull')
  scope: acr
  properties: {
    principalId: seedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource seedJob 'Microsoft.App/jobs@2024-03-01' = {
  name: seedJobName
  location: location
  dependsOn: [
    seedAcrPull
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${seedIdentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'seed-job'
  }
  properties: {
    environmentId: containerAppEnvId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 2000
      replicaRetryLimit: 0
      secrets: []
      registries: [
        {
          identity: seedIdentity.id
          server: acr.properties.loginServer
        }
      ]
    }
    template: {
      containers: [
        {
          name: seedJobName
          image: !empty(imageName) ? '${acr.properties.loginServer}/${imageName}' : bootstrapImage
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          volumeMounts: [
            {
              volumeName: 'logs'
              mountPath: '/logs'
            }
          ]
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
              value: seedIdentityName
            }
            {
              name: 'RUNTIME_MANAGED_IDENTITY_NAME'
              value: identityName
            }
            {
              name: 'RUNTIME_MANAGED_IDENTITY_CLIENT_ID'
              value: azidentity.properties.clientId
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
              value: seedIdentity.properties.clientId
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'logs'
          storageType: 'AzureFile'
          storageName: 'seed-job'
        }
      ]
    }
  }
}

output seedJobName string = seedJob.name
output seedJobId string = seedJob.id
