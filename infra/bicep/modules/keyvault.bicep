// =============================================================================
// Azure Key Vault — Secrets management
// =============================================================================

@description('Resource name prefix')
param prefix string

@description('Azure region')
param location string

@description('Resource tags')
param tags object

// ---------------------------------------------------------------------------
// Key Vault
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: replace('${prefix}-kv', '-', '')
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId

    // Use RBAC for access control (preferred over access policies)
    enableRbacAuthorization: true

    // Soft delete and purge protection for production safety
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true

    // Network access
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Key Vault URI')
output vaultUri string = keyVault.properties.vaultUri

@description('Key Vault resource ID')
output vaultId string = keyVault.id

@description('Key Vault name')
output vaultName string = keyVault.name
