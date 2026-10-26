// =============================================================================
// Azure Service Bus — Queue for webhook delivery messages
// =============================================================================

@description('Resource name prefix')
param prefix string

@description('Azure region')
param location string

@description('Resource tags')
param tags object

// ---------------------------------------------------------------------------
// Service Bus Namespace (Standard tier)
// ---------------------------------------------------------------------------

resource sbNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: replace('${prefix}-sb', '-', '')
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    zoneRedundant: false
  }
}

// ---------------------------------------------------------------------------
// Queue: relay-deliveries
// ---------------------------------------------------------------------------

resource deliveryQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sbNamespace
  name: 'relay-deliveries'
  properties: {
    // Lock duration — how long a message is locked for processing
    lockDuration: 'PT30S'

    // Max delivery count before dead-lettering
    maxDeliveryCount: 10

    // Enable dead-letter queue for failed messages
    deadLetteringOnMessageExpiration: true

    // Duplicate detection window
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'

    // Message TTL — 72 hours (matches max event age)
    defaultMessageTimeToLive: 'P3D'

    // Max queue size in MB
    maxSizeInMegabytes: 1024

    // Enable partitioning for higher throughput
    enablePartitioning: false

    // Enable batched operations
    enableBatchedOperations: true
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Service Bus namespace name')
output namespaceName string = sbNamespace.name

@description('Delivery queue name')
output queueName string = deliveryQueue.name

@description('Service Bus namespace resource ID')
output namespaceId string = sbNamespace.id
