-- signing_secret_ciphertext holds AES-256-GCM(iv || ciphertext || tag) of the
-- endpoint signing secret. It is never returned by read APIs.
CREATE TABLE webhook_endpoints (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(id),
    url                        TEXT NOT NULL,
    description                TEXT,
    signing_secret_ciphertext  BYTEA NOT NULL,
    status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_endpoints_tenant_status ON webhook_endpoints (tenant_id, status);
