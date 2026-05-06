param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param mcpInspectorName string = 'av-mcp-inspector-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param containerAppEnvId string
param containerAppEnvDefaultDomain string
param bootstrapImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
@minValue(0)
@maxValue(25)
param minReplica int = 0
@minValue(0)
@maxValue(25)
param maxReplica int = 1
@secure()
param revisionSuffix string
param apiMcpUrl string = ''
param apiDabMcpUrl string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Compute the inspector's own FQDN deterministically so we can set MCP_PROXY_FULL_ADDRESS
// Azure Container Apps FQDN = <app-name>.<env-default-domain>
var inspectorFqdn = '${mcpInspectorName}.${containerAppEnvDefaultDomain}'

resource mcpInspector 'Microsoft.App/containerApps@2024-03-01' = {
  name: mcpInspectorName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'mcp-inspector'
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
        stickySession: {
          affinity: 'sticky'
        }
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
          name: mcpInspectorName
          image: bootstrapImage
          resources: {
            cpu: json('.25')
            memory: '.5Gi'
          }
          env: [
            {
              name: 'API_MCP_URL'
              value: apiMcpUrl
            }
            {
              name: 'API_DAB_MCP_URL'
              value: apiDabMcpUrl
            }
            {
              name: 'MCP_PROXY_FULL_ADDRESS'
              value: 'https://${inspectorFqdn}/proxy'
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
      scale: {
        minReplicas: minReplica
        maxReplicas: maxReplica
      }
    }
  }
}

output mcpInspectorUrl string = 'https://${mcpInspector.properties.configuration.ingress.fqdn}'
output mcpInspectorFqdn string = mcpInspector.properties.configuration.ingress.fqdn
output mcpInspectorName string = mcpInspector.name
