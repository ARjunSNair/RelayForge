// =============================================================================
// RelayForge — Azure Infrastructure (Main Deployment)
// =============================================================================
// Orchestrates all infrastructure modules for the RelayForge platform.
// Usage:
//   az deployment group create \
//     --resource-group rg-relayforge-<env> \
//     --template-file infra/bicep/main.bicep \
//     --parameters environment=dev postgresAdminPassword=<secret>
// =============================================================================

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Deployment environment name (dev, staging, prod)')
@allowed(['dev', 'staging', 'prod'])
param environment string = 'dev'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('PostgreSQL administrator password')
@secure()
param postgresAdminPassword string

@description('Common tags applied to all resources')
param tags object = {
  project: 'RelayForge'
  environment: environment
  managedBy: 'bicep'
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

var prefix = 'relayforge-${environment}'

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

module monitoring './modules/monitoring.bicep' = {
  name: '${prefix}-monitoring'
  params: {
    prefix: prefix
    location: location
    tags: tags
  }
}

module serviceBus './modules/service-bus.bicep' = {
  name: '${prefix}-servicebus'
  params: {
    prefix: prefix
    location: location
    tags: tags
  }
}

module postgres './modules/postgres.bicep' = {
  name: '${prefix}-postgres'
  params: {
    prefix: prefix
    location: location
    tags: tags
    adminPassword: postgresAdminPassword
  }
}

module keyVault './modules/keyvault.bicep' = {
  name: '${prefix}-keyvault'
  params: {
    prefix: prefix
    location: location
    tags: tags
  }
}

module containerApps './modules/container-apps.bicep' = {
  name: '${prefix}-container-apps'
  params: {
    prefix: prefix
    location: location
    tags: tags
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    serviceBusNamespaceName: serviceBus.outputs.namespaceName
    serviceBusQueueName: serviceBus.outputs.queueName
    postgresHost: postgres.outputs.fqdn
    keyVaultUri: keyVault.outputs.vaultUri
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('API endpoint URL')
output apiUrl string = containerApps.outputs.apiUrl

@description('Service Bus namespace name')
output serviceBusNamespace string = serviceBus.outputs.namespaceName

@description('PostgreSQL server FQDN')
output postgresHost string = postgres.outputs.fqdn

@description('Key Vault URI')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Application Insights connection string')
output appInsightsConnectionString string = monitoring.outputs.appInsightsConnectionString
