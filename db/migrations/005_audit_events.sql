-- Append-only audit trail for security-relevant tenant actions
-- (endpoint changes, secret rotation, replay). Never stores secrets.
CREATE TABLE audit_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    api_key_id     UUID REFERENCES api_keys(id),
    action         TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    UUID NOT NULL,
    request_id     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_tenant_created ON audit_events (tenant_id, created_at DESC);
