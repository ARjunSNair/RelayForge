-- Iteration 2: key-versioned secrets, rotation overlap, delivery fairness,
-- trace propagation, API key management, distributed rate limiting, retention.

-- Signing secrets record which encryption key sealed them, so the data key can
-- be rotated: new writes use the primary key, old rows stay readable until rewrapped.
-- During a secret rotation with an overlap window the previous secret is kept
-- (encrypted) and deliveries are signed with both until it expires.
-- Existing rows were sealed with the iteration-1 key, whose default id is 'k1'.
ALTER TABLE webhook_endpoints
    ADD COLUMN signing_secret_key_id               TEXT NOT NULL DEFAULT 'k1',
    ADD COLUMN previous_signing_secret_ciphertext  BYTEA,
    ADD COLUMN previous_signing_secret_key_id      TEXT,
    ADD COLUMN previous_secret_expires_at          TIMESTAMPTZ,
    -- Per-endpoint cap on concurrent attempts; NULL means the worker default.
    ADD COLUMN max_concurrency                     INT CHECK (max_concurrency BETWEEN 1 AND 100),
    -- Circuit breaker: consecutive retryable failures, and suppression while open.
    ADD COLUMN consecutive_failures                INT NOT NULL DEFAULT 0,
    ADD COLUMN suppressed_until                    TIMESTAMPTZ,
    ADD CONSTRAINT ck_previous_secret_complete CHECK (
        (previous_signing_secret_ciphertext IS NULL) =
        (previous_signing_secret_key_id IS NULL AND previous_secret_expires_at IS NULL)
    );
ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret_key_id DROP DEFAULT;

-- Counting in-flight attempts per endpoint and per tenant when claiming.
CREATE INDEX idx_deliveries_in_progress_endpoint ON deliveries (endpoint_id) WHERE status = 'in_progress';
CREATE INDEX idx_deliveries_in_progress_tenant ON deliveries (tenant_id) WHERE status = 'in_progress';

-- W3C trace context of the request that accepted the event, propagated
-- through the outbox and queue message to the worker and destination.
ALTER TABLE events ADD COLUMN traceparent TEXT;
ALTER TABLE outbox_events ADD COLUMN traceparent TEXT;

-- API keys managed through the API carry a label and their creator.
ALTER TABLE api_keys
    ADD COLUMN name                   TEXT,
    ADD COLUMN created_by_api_key_id  UUID REFERENCES api_keys(id);

-- Fixed-window request counters shared by all API replicas. Unlogged: losing
-- counters on a crash only resets the current window.
CREATE UNLOGGED TABLE rate_limit_counters (
    key           TEXT NOT NULL,
    window_start  TIMESTAMPTZ NOT NULL,
    count         INT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_rate_limit_counters_expires ON rate_limit_counters (expires_at);

-- Retention scans.
CREATE INDEX idx_outbox_published ON outbox_events (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX idx_outbox_event ON outbox_events (event_id);
CREATE INDEX idx_events_created ON events (created_at);
