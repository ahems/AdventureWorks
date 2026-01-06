targetScope = 'resourceGroup'
param resourceToken string = toLower(uniqueString(resourceGroup().id, environmentName, location))
param environmentName string
param cognitiveservicesname string
param keyVaultName string = 'av-kv-${resourceToken}'
param identityName string = 'av-identity-${resourceToken}'
param appInsightsName string = 'av-appinsights-${toLower(resourceToken)}'
param workspaceName string = 'av-workspace-${toLower(resourceToken)}'
param acrName string = 'avacr${toLower(resourceToken)}'
param sqlServerName string = 'av-sql-${toLower(resourceToken)}'
param diagnosticsName string = 'acr-diagnostics-${toLower(resourceToken)}'
param cognitiveservicesLocation string = resourceGroup().location
param location string = resourceGroup().location
param adminUserEnabled bool = true
param aadAdminLogin string
param aadAdminObjectId string
@description('Wether to restore the OpenAI service or not. If set to true, the OpenAI service will be restored from a soft-deleted backup. Use this only if you have previously deleted the OpenAI service created with this script, as you will need to restore it.')
param restoreOpenAi bool
param useFreeLimit bool
param openAiDeploymentName string = 'chat'
param chatGptModelName string
param chatGptDeploymentName string = 'chat'
param chatGptDeploymentVersion string
param chatGptSkuName string
param availableChatGptDeploymentCapacity int
param embeddingModelName string
param embeddingDeploymentName string = 'embedding'
param embeddingDeploymentVersion string
param embeddingSkuName string
param availableEmbeddingDeploymentCapacity int
param imageModelName string = ''
param imageDeploymentName string = 'gpt-image-1'
param imageDeploymentVersion string = ''
param imageSkuName string = ''
param availableImageDeploymentCapacity int = 0
param imageModelFormat string = 'OpenAI'
// Generate a short, unique revision suffix per deployment to avoid conflicts
param revisionSuffix string = toLower(substring(replace(newGuid(),'-',''), 0, 8))
param AIServicesKind string = 'AIServices'
param publicNetworkAccess string = 'Enabled'
param sqlDatabaseName string

var chatGptDeploymentCapacity = availableChatGptDeploymentCapacity / 10
var embeddingDeploymentCapacity = availableEmbeddingDeploymentCapacity / 10
var imageDeploymentCapacity = availableImageDeploymentCapacity > 0 ? availableImageDeploymentCapacity / 10 : 0

module identity 'modules/identity.bicep' = {
  name: 'Deploy-User-Managed-Identity'
  params: {
    identityName: identityName
    location: location
  }
}

module storage 'modules/storage.bicep' = {
  name: 'Deploy-Storage-Account'
  params: {
    location: location
    identityId: identity.outputs.principalId
    aadAdminObjectId: aadAdminObjectId
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'Deploy-KeyVault'
  params: {
    keyVaultName: keyVaultName
    location: location
    identityName: identityName
    aadAdminObjectId: aadAdminObjectId
  }
  dependsOn: [
    identity
  ]
}

module cognitiveservices 'modules/aiservices.bicep' = {
  name: 'Deploy-AI-Foundry'
  params: {
    name: cognitiveservicesname
    location: cognitiveservicesLocation
    identityName: identityName
    customSubDomainName: cognitiveservicesname
    restoreOpenAi: restoreOpenAi
    chatGptModelName: chatGptModelName
    chatGptDeploymentName: chatGptDeploymentName
    chatGptDeploymentVersion: chatGptDeploymentVersion
    chatGptDeploymentCapacity: chatGptDeploymentCapacity
    chatGptSkuName: chatGptSkuName
    keyVaultName: keyVaultName
    embeddingModelName: embeddingModelName
    embeddingDeploymentName: embeddingDeploymentName
    embeddingDeploymentVersion: embeddingDeploymentVersion
    embeddingDeploymentCapacity: embeddingDeploymentCapacity
    embeddingSkuName: embeddingSkuName
    imageModelName: imageModelName
    imageDeploymentName: imageDeploymentName
    imageDeploymentVersion: imageDeploymentVersion
    imageDeploymentCapacity: imageDeploymentCapacity
    imageSkuName: imageSkuName
    imageModelFormat: imageModelFormat
    openAiDeploymentName: openAiDeploymentName
    kind: AIServicesKind
    publicNetworkAccess: publicNetworkAccess
    aadAdminObjectId: aadAdminObjectId
    projectName: 'av-aiproject-${resourceToken}'
    storageAccountName: storage.outputs.storageAccountName
  }
  dependsOn: [
    keyvault
  ]
}

module database 'modules/database.bicep' = {
  name: 'Deploy-Database'
  params: {
    keyVaultName: keyVaultName
    sqlServerName: sqlServerName
    aadAdminLogin: aadAdminLogin
    aadAdminObjectId: aadAdminObjectId
    location: location
    identityName: identityName
    useFreeLimit: useFreeLimit
    sqlDatabaseName: sqlDatabaseName
  }
  dependsOn: [
    keyvault
  ]
}

module acr 'modules/acr.bicep' = {
  name: 'Deploy-ACR'
  params: {
    acrName: acrName
    identityName: identityName
    workspaceName: workspaceName
    adminUserEnabled: adminUserEnabled
    diagnosticsName: diagnosticsName
    location: location
  }
  dependsOn: [
    identity
  ]
}

// Surface ACR endpoint for azd environment injection
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.outputs.loginServer

module appinsights 'modules/applicationinsights.bicep' = {
  name: 'Deploy-Application-Insights'
  params: {
    appName: appInsightsName
    workspaceName: workspaceName
    identityName: identityName
    location: location
    aadAdminObjectId: aadAdminObjectId
  }
  dependsOn: [
    identity
  ]
}

module containerApp 'modules/aca.bicep' = {
  name: 'Deploy-Container-App-Environment'
  params: {
    location: location
    appInsightsName:appInsightsName
    containerAppEnvName:'av-env-${resourceToken}'
    workspaceName:workspaceName
    containerRegistryName:acrName
    identityName:identityName
  }
  dependsOn: [
    appinsights
    identity
    acr
  ]
}

module containerAppApi 'modules/aca-api.bicep' = {
  name: 'Deploy-Container-App-API'
  params: {
    location: location
    appInsightsName:appInsightsName
    apiName:'av-api-${resourceToken}'
    containerRegistryName:acrName
    identityName:identityName
    sqlConnectionString: database.outputs.connectionString
    revisionSuffix:revisionSuffix
    keyVaultName:keyVaultName
    containerAppEnvId: containerApp.outputs.containerAppEnvId
    minReplica:0
    maxReplica:3
  }
  dependsOn: [
    keyvault
  ]
}

module staticWebAppFrontend 'modules/swa-app.bicep' = {
  name: 'Deploy-Static-Web-App-Frontend'
  params: {
    swaName: 'av-swa-${resourceToken}'
    location: location
    identityName: identityName
    apiUrl: containerAppApi.outputs.apiUrl
    apiFunctionsUrl: containerAppApiFunctions.outputs.apiFunctionsUrl
    keyVaultName: keyVaultName
  }
  dependsOn: [
    cognitiveservices
    keyvault
  ]
}

module containerAppApiFunctions 'modules/aca-api-functions.bicep' = {
  name: 'Deploy-Container-App-API-Functions'
  params: {
    location: location
    appInsightsName: appInsightsName
    apiFunctionsName: 'av-func-${resourceToken}'
    containerRegistryName: acrName
    identityName: identityName
    sqlConnectionString: database.outputs.connectionString
    aiFoundryEndpoint: cognitiveservices.outputs.endpoint
    storageAccountName: storage.outputs.storageAccountName
    minReplica: 0
    maxReplica: 3
    revisionSuffix: revisionSuffix
    containerAppEnvId: containerApp.outputs.containerAppEnvId
  }
  dependsOn: [
    keyvault
    storage
  ]
}

output APP_REDIRECT_URI string = staticWebAppFrontend.outputs.appRedirectUri

// Expose values needed for local debugging / .env population
// Key Vault name (already determined as a param -> output for azd env injection)
output KEY_VAULT_NAME string = keyVaultName

// Application Insights connection string (need to reference component resource id after module deployment)
// The module doesn't output it directly, so recreate the name and reference the implicit resource symbol in the module via existing name
// appinsights module uses name appInsightsName; we can read its properties via symbolic name 'appinsights'.
output APPLICATIONINSIGHTS_CONNECTION_STRING string = containerApp.outputs.applicationInsightsConnectionString

// API URL (GraphQL endpoint) - constructed similarly to what aca module sets inside env values
// The middle tier container app FQDN is not surfaced directly; derive using known naming convention from aca module parameters
// We add an output in aca module instead would be cleaner, but for now replicate pattern: apiName = 'av-api-${resourceToken}'
// Since containerApp module internal resource name uses apiName param, we cannot access its properties here without an output. TODO: add output in aca module.
// Placeholder output (empty) until module is updated; avoids breaking template. Next change will add actual output from aca module.
output API_URL string = containerAppApi.outputs.apiUrl

// Azure Client Id of the user-assigned managed identity
output AZURE_CLIENT_ID string = identity.outputs.clientId

output USER_MANAGED_IDENTITY_NAME string = identityName

output SQL_SERVER_NAME string = sqlServerName

output STORAGE_ACCOUNT_NAME string = storage.outputs.storageAccountName

// Service names for azd deploy mapping (required by azd CLI)
output SERVICE_APP_NAME string = staticWebAppFrontend.outputs.staticWebAppName
output SERVICE_API_NAME string = 'av-api-${resourceToken}'
output SERVICE_API_FUNCTIONS_NAME string = 'av-func-${resourceToken}'

output API_FUNCTIONS_URL string = containerAppApiFunctions.outputs.apiFunctionsUrl

// Static Web App deployment token for azd deploy
output AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN string = staticWebAppFrontend.outputs.deploymentToken
