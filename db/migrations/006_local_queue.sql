-- PostgreSQL-backed queue used for local development and integration tests
-- (QUEUE_TRANSPORT=postgres). It mimics the Service Bus semantics the worker
-- relies on: message-id de-duplication, peek-lock with a lock token,
-- abandon/complete and dead-lettering. Not used when QUEUE_TRANSPORT=servicebus.
CREATE TABLE local_queue_messages (
    queue               TEXT NOT NULL,
    message_id          TEXT NOT NULL,
    body                JSONB NOT NULL,
    properties          JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_count      INT NOT NULL DEFAULT 0,
    visible_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    lock_token          UUID,
    dead_lettered_at    TIMESTAMPTZ,
    dead_letter_reason  TEXT,
    enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (queue, message_id)
);

CREATE INDEX idx_local_queue_visible
    ON local_queue_messages (queue, visible_at)
    WHERE dead_lettered_at IS NULL;
