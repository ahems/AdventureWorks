param swaName string
param location string = resourceGroup().location
param identityName string
param apiUrl string
param apiFunctionsUrl string = ''
param keyVaultName string

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

// Configure app settings for build-time environment variables
resource swaConfig 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    VITE_API_URL: apiUrl
    VITE_API_FUNCTIONS_URL: apiFunctionsUrl
  }
}

// Note: Build-time environment variables (like VITE_API_URL) are passed by azd during deployment
// Static Web Apps with no API functions don't need app settings configured here
// The frontend is a static SPA that gets its config baked in at build time

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource redirecturi 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'REDIRECT-URI'
  properties: {
    value: 'https://${staticWebApp.properties.defaultHostname}/getAToken'
    contentType: 'text/plain'
  }
}

output appRedirectUri string = 'https://${staticWebApp.properties.defaultHostname}'
output appFqdn string = staticWebApp.properties.defaultHostname
output deploymentToken string = staticWebApp.listSecrets().properties.apiKey
output staticWebAppName string = staticWebApp.name
