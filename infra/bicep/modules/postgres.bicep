// =============================================================================
// Azure Database for PostgreSQL Flexible Server
// =============================================================================

@description('Resource name prefix')
param prefix string

@description('Azure region')
param location string

@description('Resource tags')
param tags object

@description('Administrator login name')
param adminLogin string = 'relayforge_admin'

@description('Administrator login password')
@secure()
param adminPassword string

@description('PostgreSQL version')
@allowed(['14', '15', '16'])
param postgresVersion string = '16'

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------------------

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: replace('${prefix}-pg', '-', '')
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: postgresVersion
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0  // Sunday
      startHour: 2
      startMinute: 0
    }
  }
}

// ---------------------------------------------------------------------------
// Firewall Rules
// ---------------------------------------------------------------------------

// Allow Azure services to access the server
resource firewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgresServer
  name: 'relayforge'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------

// Enable pgcrypto extension
resource configExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: 'UUID-OSSP,PGCRYPTO'
    source: 'user-override'
  }
}

// Log slow queries (>1 second)
resource configLogMinDuration 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'log_min_duration_statement'
  properties: {
    value: '1000'
    source: 'user-override'
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('PostgreSQL server FQDN')
output fqdn string = postgresServer.properties.fullyQualifiedDomainName

@description('PostgreSQL server resource ID')
output serverId string = postgresServer.id

@description('Database name')
output databaseName string = database.name
