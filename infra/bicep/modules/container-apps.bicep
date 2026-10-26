// =============================================================================
// Azure Container Apps — Application hosting
// =============================================================================

@description('Resource name prefix')
param prefix string

@description('Azure region')
param location string

@description('Resource tags')
param tags object

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Service Bus namespace name')
param serviceBusNamespaceName string

@description('Service Bus queue name')
param serviceBusQueueName string

@description('PostgreSQL server hostname')
param postgresHost string

@description('Key Vault URI')
param keyVaultUri string

@description('Container image registry')
param containerRegistry string = 'ghcr.io/relayforge'

@description('Container image tag')
param imageTag string = 'latest'

// ---------------------------------------------------------------------------
// User-Assigned Managed Identity
// ---------------------------------------------------------------------------

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-identity'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Container Apps Environment
// ---------------------------------------------------------------------------

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-11-02-preview' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsWorkspaceId, '2022-10-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2022-10-01').primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

// ---------------------------------------------------------------------------
// Shared environment variables
// ---------------------------------------------------------------------------

var sharedEnvVars = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'OTEL_SERVICE_NAME', value: 'relayforge' }
  { name: 'SERVICE_BUS_QUEUE_NAME', value: serviceBusQueueName }
  { name: 'KEY_VAULT_URI', value: keyVaultUri }
  { name: 'POSTGRES_HOST', value: postgresHost }
]

// ---------------------------------------------------------------------------
// Container App: API
// ---------------------------------------------------------------------------

resource apiApp 'Microsoft.App/containerApps@2023-11-02-preview' = {
  name: '${prefix}-api'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*']
          allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
          allowedHeaders: ['*']
        }
      }
      registries: []
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${containerRegistry}/api:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(sharedEnvVars, [
            { name: 'PORT', value: '3000' }
            { name: 'OTEL_SERVICE_NAME', value: 'relayforge-api' }
          ])
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Container App: Outbox Publisher
// ---------------------------------------------------------------------------

resource publisherApp 'Microsoft.App/containerApps@2023-11-02-preview' = {
  name: '${prefix}-publisher'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      // No ingress — internal process only
      registries: []
    }
    template: {
      containers: [
        {
          name: 'publisher'
          image: '${containerRegistry}/outbox-publisher:${imageTag}'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(sharedEnvVars, [
            { name: 'OTEL_SERVICE_NAME', value: 'relayforge-publisher' }
          ])
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Container App: Delivery Worker
// ---------------------------------------------------------------------------

resource workerApp 'Microsoft.App/containerApps@2023-11-02-preview' = {
  name: '${prefix}-worker'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      // No ingress — internal process only
      registries: []
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${containerRegistry}/delivery-worker:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(sharedEnvVars, [
            { name: 'OTEL_SERVICE_NAME', value: 'relayforge-worker' }
          ])
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [
          {
            name: 'queue-depth'
            custom: {
              type: 'azure-servicebus'
              metadata: {
                queueName: serviceBusQueueName
                namespace: serviceBusNamespaceName
                messageCount: '10'
              }
              auth: [
                {
                  secretRef: 'servicebus-connection'
                  triggerParameter: 'connection'
                }
              ]
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('API application URL')
output apiUrl string = 'https://${apiApp.properties.configuration.ingress.fqdn}'

@description('Managed identity principal ID')
output managedIdentityPrincipalId string = managedIdentity.properties.principalId

@description('Managed identity client ID')
output managedIdentityClientId string = managedIdentity.properties.clientId
