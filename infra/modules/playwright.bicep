// Playwright Workspaces Bicep Module
// 
// Creates a Playwright Workspace in Azure LoadTest Service for cloud-scale browser testing.
// This is the NEW service that replaces deprecated Microsoft.AzurePlaywrightService (retiring 2026-03-08).
//
// Resource: Microsoft.LoadTestService/playwrightWorkspaces@2026-01-01-preview
// Supported Locations: eastus, westus3, westeurope, eastasia
//
// Key Differences from Old Service:
// - Different resource provider (LoadTestService vs AzurePlaywrightService)
// - Different role assignments (Workspace Admin/Contributor vs Service Administrator/User)
// - Properties: dataplaneUri, workspaceId (no longer reporting, scalableExecution properties)
// - Dashboard accessed via Azure Portal resource view
//
// Migration Guide: https://aka.ms/mpt/migration-guidance

param playwrightWorkspaceName string = 'pw${toLower(uniqueString(resourceGroup().id))}'
@description('Location for Playwright Workspaces in Azure LoadTest Service. Supported: eastus, westus3, westeurope, eastasia')
@allowed(['eastus', 'westus3', 'westeurope', 'eastasia'])
param location string
param identityName string
param aadAdminObjectId string
param storageAccountName string

// Reference the user-assigned managed identity
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// Reference the storage account for test artifacts and reports
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Configure CORS for Playwright trace viewer access
resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: [
            'https://trace.playwright.dev'
          ]
          allowedMethods: [
            'GET'
            'OPTIONS'
          ]
          maxAgeInSeconds: 86400
          exposedHeaders: [
            '*'
          ]
          allowedHeaders: [
            '*'
          ]
        }
      ]
    }
  }
}

// Create blob container for Playwright test reports and artifacts
resource playwrightReportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobServices
  name: 'playwright-reports'
  properties: {
    publicAccess: 'None'
    metadata: {
      description: 'Container for Playwright test reports, traces, and artifacts'
      createdBy: 'Bicep deployment'
    }
  }
}

// Note: Storage Blob Data Contributor role for managed identity and admin user
// are already assigned by the storage module, so no need to duplicate here

// Playwright Workspaces resource (new service under Microsoft.LoadTestService)
// Replaces deprecated Microsoft.AzurePlaywrightService which retires 2026-03-08
resource playwrightWorkspace 'Microsoft.LoadTestService/playwrightWorkspaces@2026-01-01-preview' = {
  name: playwrightWorkspaceName
  location: location
  properties: {
    regionalAffinity: 'Disabled' // No regional affinity needed for most scenarios
    localAuth: 'Disabled' // Disable local auth to enforce AAD only
    storageUri: storageAccount.properties.primaryEndpoints.blob // Storage for test artifacts and reports
  }
  tags: {
    Environment: 'Development'
    Purpose: 'E2E Testing'
    Service: 'Playwright Workspaces (Azure LoadTest Service)'
  }
}

// Assign Load Test Owner role to the admin user for full workspace management
// Load Test Owner provides full access to Playwright Workspaces in LoadTestService
resource playwrightAdminRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(playwrightWorkspace.id, aadAdminObjectId, 'LoadTestOwner')
  scope: playwrightWorkspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '45bb0b16-2f0c-4e78-afaa-a07599b003f6') // Load Test Owner
    principalId: aadAdminObjectId
    principalType: 'User'
  }
}

// Assign Load Test Contributor role to the managed identity for automated testing
// Load Test Contributor allows running tests and managing test executions
resource playwrightIdentityRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(playwrightWorkspace.id, identityName, 'LoadTestContributor')
  scope: playwrightWorkspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '749a398d-560b-491b-bb21-08924219302e') // Load Test Contributor
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output playwrightWorkspaceId string = playwrightWorkspace.id
output playwrightWorkspaceName string = playwrightWorkspace.name
output playwrightWorkspaceGuid string = playwrightWorkspace.properties.workspaceId
output playwrightDashboardUrl string = 'https://portal.azure.com/#resource${playwrightWorkspace.id}'
output playwrightServiceUrl string = '${replace(playwrightWorkspace.properties.dataplaneUri, 'https://', 'wss://')}/browsers'
output storageAccountName string = storageAccountName
output reportsContainerName string = 'playwright-reports'
output reportsContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}playwright-reports'
