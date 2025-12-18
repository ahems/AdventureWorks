param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param apiFunctionsName string = 'av-func-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param containerAppEnvId string
param bootstrapImage string = 'mcr.microsoft.com/azure-functions/dotnet-isolated:4-dotnet-isolated8.0'
@minValue(0)
@maxValue(25)
param minReplica int = 0
@minValue(0)
@maxValue(25)
param maxReplica int = 3
@secure()
param revisionSuffix string
@secure()
param sqlConnectionString string
param aiFoundryEndpoint string = ''
param storageAccountName string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource apiFunctions 'Microsoft.App/containerApps@2025-10-02-preview' = {
  name: apiFunctionsName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'api-functions'
  }
  properties: {
    managedEnvironmentId: containerAppEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      secrets: [
        {
          name: 'sql-connection-string'
          value: sqlConnectionString
        }
      ]
      runtime: {
        dotnet: {
          autoConfigureDataProtection: true
        }
      }
      ingress: {
        external: true
        targetPort: 80
        allowInsecure: false
        transport: 'http'
        clientCertificateMode: 'ignore'
        corsPolicy: {
          allowedOrigins: ['*']
          allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
          allowCredentials: false
        }
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          identity: azidentity.id
          server: acr.properties.loginServer
        }
      ]
    }
    template: {
      revisionSuffix: revisionSuffix
      containers: [
        {
          name: apiFunctionsName
          image: bootstrapImage
          resources: {
            cpu: json('.25')
            memory: '.5Gi'
          }
          env: [
            {
              name: 'SQL_CONNECTION_STRING'
              value: sqlConnectionString
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: azidentity.properties.clientId
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: aiFoundryEndpoint
            }
            {
              name: 'AzureWebJobsStorage__accountName'
              value: storageAccountName
            }
            {
              name: 'AzureWebJobsStorage__credential'
              value: 'managedidentity'
            }
            {
              name: 'AzureWebJobsStorage__clientId'
              value: azidentity.properties.clientId
            }
            {
              name: 'AzureWebJobsStorage__blobServiceUri'
              value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}'
            }
            {
              name: 'AzureWebJobsStorage__queueServiceUri'
              value: 'https://${storageAccountName}.queue.${environment().suffixes.storage}'
            }
            {
              name: 'AzureWebJobsStorage__tableServiceUri'
              value: 'https://${storageAccountName}.table.${environment().suffixes.storage}'
            }
            {
              name: 'FUNCTIONS_WORKER_RUNTIME'
              value: 'dotnet-isolated'
            }
            {
              name: 'FUNCTIONS_EXTENSION_VERSION'
              value: '~4'
            }
            {
              name: 'WEBSITE_HOSTNAME'
              value: '${apiFunctionsName}.${replace(replace(containerAppEnvId, '/subscriptions/', ''), '/resourceGroups/', '')}.azurecontainerapps.io'
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplica
        maxReplicas: maxReplica
        rules: [
          {
            name: 'http-requests'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output apiFunctionsUrl string = 'https://${apiFunctions.properties.configuration.ingress.fqdn}'
output apiFunctionsFqdn string = apiFunctions.properties.configuration.ingress.fqdn
output apiFunctionsName string = apiFunctions.name
