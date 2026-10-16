param virtualNetworkName string
param location string
param sqlServerName string

var sqlPrivateDnsZoneName = replace(environment().suffixes.sqlServerHostname, '.database.', 'privatelink.database.')

// VNet with subnets defined inline. Azure creates the VNet and all subnets in one
// operation, which avoids AnotherOperationInProgress conflicts from parallel subnet creates.
resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'functions-integration'
        properties: {
          addressPrefix: '10.42.2.0/26'
          delegations: [
            {
              name: 'functions-integration'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.42.3.0/27'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }

  // Read-only references to the inline subnets (these don't create or update anything)
  resource containerAppsSubnet 'subnets' existing = {
    name: 'container-apps'
  }

  resource functionsSubnet 'subnets' existing = {
    name: 'functions-integration'
  }

  resource privateEndpointSubnet 'subnets' existing = {
    name: 'private-endpoints'
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: sqlPrivateDnsZoneName
  location: 'global'
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: '${virtualNetworkName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' existing = {
  name: sqlServerName
}

resource sqlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${sqlServerName}-private-endpoint'
  location: location
  properties: {
    subnet: {
      id: virtualNetwork::privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${sqlServerName}-private-link'
        properties: {
          privateLinkServiceId: sqlServer.id
          groupIds: [
            'sqlServer'
          ]
        }
      }
    ]
  }
  dependsOn: [
    privateDnsZoneLink
  ]
}

resource sqlPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: sqlPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'sql-server'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
}

output containerAppsSubnetId string = virtualNetwork::containerAppsSubnet.id
output functionsSubnetId string = virtualNetwork::functionsSubnet.id
