CREATE TABLE deliveries (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL,
    event_id               UUID NOT NULL REFERENCES events(id),
    endpoint_id            UUID NOT NULL REFERENCES webhook_endpoints(id),
    status                 TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'in_progress', 'succeeded', 'retry_scheduled', 'dead_lettered', 'cancelled')),
    -- Number of the most recently claimed attempt. Queue messages carry the
    -- attempt number they are allowed to execute, which fences stale messages.
    attempt_count          INT NOT NULL DEFAULT 0,
    next_attempt_at        TIMESTAMPTZ,
    last_attempt_at        TIMESTAMPTZ,
    succeeded_at           TIMESTAMPTZ,
    -- Lease held by a worker while status = 'in_progress'.
    locked_until           TIMESTAMPTZ,
    dead_letter_reason     TEXT,
    replay_of_delivery_id  UUID REFERENCES deliveries(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deliveries_tenant_created ON deliveries (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_deliveries_status_next ON deliveries (status, next_attempt_at);
CREATE INDEX idx_deliveries_event ON deliveries (event_id);
CREATE INDEX idx_deliveries_replay_of ON deliveries (replay_of_delivery_id) WHERE replay_of_delivery_id IS NOT NULL;

-- Attempt records are immutable history.
CREATE TABLE delivery_attempts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    delivery_id       UUID NOT NULL REFERENCES deliveries(id),
    attempt_number    INT NOT NULL,
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ,
    http_status       INT,
    duration_ms       INT,
    outcome           TEXT NOT NULL CHECK (outcome IN ('succeeded', 'retryable_failure', 'permanent_failure')),
    error_code        TEXT,
    response_excerpt  TEXT,
    trace_id          TEXT,
    CONSTRAINT uq_delivery_attempt UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX idx_delivery_attempts_delivery ON delivery_attempts (delivery_id, attempt_number DESC);
