// =============================================================================
// keyvault.bicep
// RBAC-enabled Azure Key Vault that stores the RSA signing certificate for the
// api-mcp self-contained OAuth authorization server.
//
// - Azure RBAC authorization (NOT legacy access policies).
// - The api-mcp runtime managed identity is granted ONLY "Key Vault Secrets
//   User" (data-plane, read) scoped to THIS vault, so it can read the signing
//   certificate's PFX. It is never a Key Vault Administrator.
// - Purge protection is intentionally left disabled so `azd down` can fully
//   remove the vault with the environment.
//
// The signing certificate itself is created after provisioning by the
// postprovision hook (`az keyvault certificate create`), which also grants the
// deployer the "Key Vault Certificates Officer" role on this vault.
// =============================================================================

@description('Globally-unique Key Vault name (3-24 chars).')
param keyVaultName string

param location string = resourceGroup().location

@description('Principal ID of the api-mcp runtime managed identity (granted Key Vault Secrets User).')
param runtimeIdentityPrincipalId string

@description('Soft-delete retention in days. Minimum 7. Kept low for a demo environment.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 7

// Built-in role: Key Vault Secrets User (read secret contents, incl. certificate PFX).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // Purge protection deliberately omitted (disabled) so `azd down` can purge.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Least-privilege data-plane role for the runtime identity, scoped to this vault only.
resource secretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, runtimeIdentityPrincipalId, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
