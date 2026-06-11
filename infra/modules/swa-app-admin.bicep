param swaAdminName string
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param location string = 'eastus2'
param identityName string
param apiUrl string
param apiFunctionsUrl string = ''
param apiMcpUrl string = ''
param appInsightsConnectionString string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource staticWebAppAdmin 'Microsoft.Web/staticSites@2023-01-01' = {
  name: swaAdminName
  location: location
  tags: {
    'azd-service-name': 'app-admin'
  }
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  properties: {
    repositoryUrl: null
    branch: null
    provider: 'None'
    buildProperties: {
      appLocation: '/'
      apiLocation: ''
      outputLocation: 'dist'
    }
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

// Configure environment variables for runtime injection into config.js
resource swaAdminConfig 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebAppAdmin
  name: 'functionappsettings'
  properties: {
    API_URL: apiUrl
    API_FUNCTIONS_URL: apiFunctionsUrl
    API_MCP_URL: apiMcpUrl
    APPINSIGHTS_CONNECTIONSTRING: appInsightsConnectionString
  }
}

output appAdminRedirectUri string = 'https://${staticWebAppAdmin.properties.defaultHostname}'
output appAdminFqdn string = staticWebAppAdmin.properties.defaultHostname
@secure()
output deploymentToken string = staticWebAppAdmin.listSecrets().properties.apiKey
output staticWebAppName string = staticWebAppAdmin.name
