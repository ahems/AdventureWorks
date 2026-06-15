param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param appManufacturingName string = 'av-app-manufactur-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param containerAppEnvId string
param bootstrapImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
@minValue(0)
@maxValue(25)
param minReplica int = 0
@minValue(0)
@maxValue(25)
param maxReplica int = 3
@secure()
param revisionSuffix string
param apiUrl string = ''
param apiFunctionsUrl string = ''
param appInsightsConnectionString string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource appManufacturing 'Microsoft.App/containerApps@2024-03-01' = {
  name: appManufacturingName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'app-manufacturing'
  }
  properties: {
    managedEnvironmentId: containerAppEnvId
    configuration: {
      ingress: {
        external: true
        targetPort: 80
        allowInsecure: false
        transport: 'http'
        clientCertificateMode: 'ignore'
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
          name: appManufacturingName
          image: bootstrapImage
          resources: {
            cpu: json('.25')
            memory: '.5Gi'
          }
          env: [
            {
              name: 'API_URL'
              value: apiUrl
            }
            {
              name: 'API_FUNCTIONS_URL'
              value: apiFunctionsUrl
            }
            {
              name: 'APPINSIGHTS_CONNECTIONSTRING'
              value: appInsightsConnectionString
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: azidentity.properties.clientId
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplica
        maxReplicas: maxReplica
      }
    }
  }
}

output appManufacturingUrl string = 'https://${appManufacturing.properties.configuration.ingress.fqdn}'
output appManufacturingFqdn string = appManufacturing.properties.configuration.ingress.fqdn
output appManufacturingName string = appManufacturing.name
