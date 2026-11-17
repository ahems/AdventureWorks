targetScope = 'resourceGroup'

@minLength(2)
@maxLength(32)
param jobName string
param location string
param environmentName string
param identityName string
param registryName string
param imageDigest string
param runId string
@secure()
param configuration string
@minValue(300)
@maxValue(7200)
param timeoutSeconds int = 7200

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: {
    purpose: 'auth-assurance'
    'auth-assurance-run': runId
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: timeoutSeconds
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: 'configuration'
          value: configuration
        }
      ]
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'assurance'
          image: '${registry.properties.loginServer}/auth-assurance@${imageDigest}'
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'AUTH_ASSURANCE_CONFIG_B64'
              secretRef: 'configuration'
            }
          ]
        }
      ]
    }
  }
}

output jobId string = job.id
