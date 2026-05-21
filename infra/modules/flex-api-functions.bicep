param appInsightsName string = 'av-appinsights-${toLower(uniqueString(resourceGroup().id))}'
param apiFunctionsName string = 'av-func-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
@secure()
param sqlConnectionString string
param aiFoundryEndpoint string = ''
param chatGptDeploymentName string = ''
param storageAccountName string = ''
param communicationServiceEndpoint string = ''
param emailSenderDomain string = ''
param foundryProjectEndpoint string = ''
param simulationTimeScaleFactor string = '60'
param simulationScrapRate string = '0.05'
param materialsRetryDelaySeconds string = '30'
param agentWorkflowChatId string = ''
param agentWorkflowPromotionId string = ''
param agentWorkflowOrderId string = ''
param agentWorkflowHelpMeChooseId string = ''

resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource flexPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${apiFunctionsName}-plan'
  location: location
  kind: 'functionapp'
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  properties: {
    reserved: true // Required for Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiFunctionsName
  location: location
  kind: 'functionapp,linux'
  tags: {
    'azd-service-name': 'api-functions'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${azidentity.id}': {}
    }
  }
  properties: {
    serverFarmId: flexPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}/function-releases'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: azidentity.id
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 5
        instanceMemoryMB: 2048
        alwaysReady: []
      }
      runtime: {
        name: 'dotnet-isolated'
        version: '8.0'
      }
    }
    siteConfig: {
      appSettings: [
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
          name: 'chatGptDeploymentName'
          value: chatGptDeploymentName
        }
        {
          name: 'EMBEDDING_GENERATION_ENDPOINT'
          value: 'https://${apiFunctionsName}.azurewebsites.net/api/GenerateProductReviewEmbeddings_HttpStart'
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
          name: 'COMMUNICATION_SERVICE_ENDPOINT'
          value: communicationServiceEndpoint
        }
        {
          name: 'EMAIL_SENDER_DOMAIN'
          value: emailSenderDomain
        }
        {
          name: 'AI_FOUNDRY_PROJECT_ENDPOINT'
          value: foundryProjectEndpoint
        }
        {
          name: 'SIMULATION_TIME_SCALE_FACTOR'
          value: simulationTimeScaleFactor
        }
        {
          name: 'SIMULATION_SCRAP_RATE'
          value: simulationScrapRate
        }
        {
          name: 'MATERIALS_RETRY_DELAY_SECONDS'
          value: materialsRetryDelaySeconds
        }
        {
          name: 'AI_AGENT_WORKFLOW_CHAT_ID'
          value: agentWorkflowChatId
        }
        {
          name: 'AI_AGENT_WORKFLOW_PROMOTION_ID'
          value: agentWorkflowPromotionId
        }
        {
          name: 'AI_AGENT_WORKFLOW_ORDER_ID'
          value: agentWorkflowOrderId
        }
        {
          name: 'AI_AGENT_WORKFLOW_HELP_ME_CHOOSE_ID'
          value: agentWorkflowHelpMeChooseId
        }
      ]
    }
  }
}

resource functionAppCors 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: functionApp
  name: 'web'
  properties: {
    cors: {
      allowedOrigins: ['*']
    }
  }
}

output apiFunctionsUrl string = 'https://${functionApp.properties.defaultHostName}'
output apiFunctionsFqdn string = functionApp.properties.defaultHostName
output apiFunctionsName string = functionApp.name
