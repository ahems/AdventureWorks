param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param apiMcpName string = 'av-mcp-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param containerRegistryName string = 'avacr${toLower(uniqueString(resourceGroup().id))}'
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param containerAppEnvId string
param bootstrapImage string = 'mcr.microsoft.com/dotnet/aspnet:10.0'
param apiFunctionsUrl string
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
param aiFoundryEndpoint string

@description('Managed environment default domain, used to derive this app FQDN for the OAuth issuer/resource without a self-reference.')
param containerAppEnvDefaultDomain string = ''

@description('Key Vault URI holding the RSA signing certificate. When empty, api-mcp uses an ephemeral dev key.')
param keyVaultUri string = ''

@description('Name of the signing certificate/secret in Key Vault.')
param signingCertificateName string = 'mcp-signing'

// Canonical public base URL (issuer) for the OAuth authorization server. Derived from the
// deployed FQDN; never a hard-coded hostname. The resource identifier is this + "/mcp".
var apiMcpPublicBaseUrl = empty(containerAppEnvDefaultDomain) ? '' : 'https://${apiMcpName}.${containerAppEnvDefaultDomain}'

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource apiMcp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiMcpName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  tags: {
    'azd-service-name': 'api-mcp'
  }
  properties: {
    managedEnvironmentId: containerAppEnvId
    configuration: {
      secrets: [
        {
          name: 'sql-connection-string'
          value: sqlConnectionString
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
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
          name: apiMcpName
          image: bootstrapImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'ConnectionStrings__AdventureWorks'
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
              name: 'API_FUNCTIONS_URL'
              value: apiFunctionsUrl
            }
            {
              name: 'ASPNETCORE_URLS'
              value: 'http://+:8080'
            }
            {
              name: 'MCP_PUBLIC_BASE_URL'
              value: apiMcpPublicBaseUrl
            }
            {
              name: 'MCP_SIGNING_KEY_VAULT_URI'
              value: keyVaultUri
            }
            {
              name: 'MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID'
              value: azidentity.properties.clientId
            }
            {
              name: 'MCP_SIGNING_CERTIFICATE_NAME'
              value: signingCertificateName
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

output apiMcpUrl string = 'https://${apiMcp.properties.configuration.ingress.fqdn}/mcp'
output apiMcpFqdn string = apiMcp.properties.configuration.ingress.fqdn
output apiMcpName string = apiMcp.name
