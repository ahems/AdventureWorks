param sqlServerName string = 'av-sql-${toLower(uniqueString(resourceGroup().id))}'
param location string = resourceGroup().location
param aadAdminLogin string
param aadAdminObjectId string
param tenantId string = subscription().tenantId
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param useFreeLimit bool
param sqlDatabaseName string

// Existing user-assigned identity
resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// Using deterministic FQDN pattern rather than module output to keep secret name stable.
var sqlServerFqdn = '${sqlServerName}${environment().suffixes.sqlServerHostname}'

module sqlServerModule 'br/public:avm/res/sql/server:0.14.0' = {
  name: 'sqlServerDeployment'
  params: {
    name: sqlServerName
    location: location
    // AAD admin mapping
    administrators: {
      azureADOnlyAuthentication: false
      login: aadAdminLogin
      sid: aadAdminObjectId
      tenantId: tenantId
      principalType: 'User'
    }
    // Identity assignment
    managedIdentities: {
      userAssignedResourceIds: [ azidentity.id ]
    }
  // AVM expects primaryUserAssignedIdentityId (not *ResourceId*) when specifying a UAI as primary
  primaryUserAssignedIdentityId: azidentity.id
    // Preserve permissive firewall behavior (legacy compatibility)
    firewallRules: [
      {
        name: 'AllowAll'
        startIpAddress: '0.0.0.0'
        endIpAddress: '255.255.255.255'
      }
    ]
    // Single database definition replicating previous properties
    databases: [
      {
        name: sqlDatabaseName
        sku: {
          name: 'GP_S_Gen5_4'
          tier: 'GeneralPurpose'
        }
        collation: 'SQL_Latin1_General_CP1_CI_AS'
        maxSizeBytes: 34359738368
        zoneRedundant: false
        readScale: 'Disabled'
        highAvailabilityReplicaCount: 0
        autoPauseDelay: 60
        // Serverless databases require a valid minCapacity (in vCores). 0 is invalid; 0.5 is the lowest allowed.
        minCapacity: '0.5'
        licenseType: 'BasePrice'
        useFreeLimit: useFreeLimit
        freeLimitExhaustionBehavior: 'AutoPause'
      }
    ]
    restrictOutboundNetworkAccess: 'Disabled'
  }
}

// Connection string with Authentication=Active Directory Default
// This uses DefaultAzureCredential (Azure CLI locally, Managed Identity in Azure)
var connectionString = 'Server=tcp:${sqlServerFqdn};Database=${sqlDatabaseName};Authentication=Active Directory Default;'

output connectionString string = connectionString
