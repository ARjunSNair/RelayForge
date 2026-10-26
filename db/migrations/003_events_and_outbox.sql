CREATE TABLE events (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id),
    event_type           TEXT NOT NULL,
    payload              JSONB NOT NULL,
    payload_hash         TEXT NOT NULL,
    -- Hash of the canonical publish request (type, data, endpointIds); used to
    -- detect reuse of an idempotency key with a different request.
    request_fingerprint  TEXT NOT NULL,
    idempotency_key      TEXT,
    status               TEXT NOT NULL DEFAULT 'accepted'
                         CHECK (status IN ('accepted', 'processing', 'completed', 'failed', 'partially_delivered')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_events_tenant_idempotency
    ON events (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_events_tenant_created ON events (tenant_id, created_at DESC);

-- Transactional outbox: written in the same transaction as the domain change,
-- relayed to the broker by the outbox publisher using leases.
CREATE TABLE outbox_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    event_id         UUID NOT NULL REFERENCES events(id),
    message_type     TEXT NOT NULL,
    payload          JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at     TIMESTAMPTZ,
    attempt_count    INT NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error_code  TEXT,
    locked_by        TEXT,
    locked_until     TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unpublished
    ON outbox_events (next_attempt_at, created_at)
    WHERE published_at IS NULL;
