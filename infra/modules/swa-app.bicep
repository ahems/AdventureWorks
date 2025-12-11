param swaName string
param location string = resourceGroup().location
param identityName string
param appInsightsName string
param apiUrl string
param apiAppIdUri string
param keyVaultName string
param openAiDeploymentName string
param redisConnectionString string

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: swaName
  location: location
  tags: {
    'azd-service-name': 'app'
  }
  sku: {
    name: 'Free'
    tier: 'Free'
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
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

// Note: Build-time environment variables (like VITE_API_URL) are passed by azd during deployment
// Runtime configuration for Static Web Apps can be set here if needed for API functions
resource swaAppSettings 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    // These are primarily for SWA API functions if used
    // The frontend app gets environment variables during build via azd
    KEY_VAULT_NAME: keyVaultName
    REDIS_CONNECTION_STRING: redisConnectionString
    AZURE_CLIENT_ID: azidentity.properties.clientId
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    AZURE_OPENAI_DEPLOYMENT_NAME: openAiDeploymentName
    API_URL: apiUrl
    API_APP_ID_URI: apiAppIdUri
  }
}

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
