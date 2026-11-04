param sqlServerName string = 'av-sql-${toLower(uniqueString(resourceGroup().id))}'
param location string = resourceGroup().location
param tenantId string = subscription().tenantId
param identityName string = 'av-identity-${uniqueString(resourceGroup().id)}'
param seedIdentityName string
param useFreeLimit bool
param sqlDatabaseName string

// Existing user-assigned identity
resource azidentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource seedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: seedIdentityName
}

// Using deterministic FQDN pattern rather than module output to keep secret name stable.
var sqlServerFqdn = '${sqlServerName}${environment().suffixes.sqlServerHostname}'

module sqlServerModule 'br/public:avm/res/sql/server:0.14.0' = {
  name: 'sqlServerDeployment'
  params: {
    name: sqlServerName
    location: location
    // Only the dedicated seed UAMI bootstraps SQL over the private endpoint.
    // No deployment-host SQL connection or Graph lookup is required.
    administrators: {
      azureADOnlyAuthentication: true
      login: seedIdentity.name
      sid: seedIdentity.properties.principalId
      tenantId: tenantId
      principalType: 'Application'
    }
    // Identity assignment
    managedIdentities: {
      userAssignedResourceIds: [ azidentity.id ]
    }
  // AVM expects primaryUserAssignedIdentityId (not *ResourceId*) when specifying a UAI as primary
  primaryUserAssignedIdentityId: azidentity.id
    publicNetworkAccess: 'Disabled'
    firewallRules: []
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
