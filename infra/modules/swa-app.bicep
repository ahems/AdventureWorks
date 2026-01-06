param swaName string
param location string = resourceGroup().location
param identityName string
param apiUrl string
param apiFunctionsUrl string = ''
param appInsightsConnectionString string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: swaName
  location: location
  tags: {
    'azd-service-name': 'app'
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
// These are injected after deployment via staticwebapp.config.json
resource swaConfig 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebApp
  name: 'functionappsettings'
  properties: {
    API_URL: apiUrl
    API_FUNCTIONS_URL: apiFunctionsUrl
    APPINSIGHTS_CONNECTIONSTRING: appInsightsConnectionString
  }
}

output appRedirectUri string = 'https://${staticWebApp.properties.defaultHostname}'
output appFqdn string = staticWebApp.properties.defaultHostname
output deploymentToken string = staticWebApp.listSecrets().properties.apiKey
output staticWebAppName string = staticWebApp.name
