# ADR-007: PostgreSQL-backed local queue and attempt-number fencing

**Status:** Accepted (iteration 1)

## Context

ADR-001 selects Azure Service Bus. Local development and CI should not need cloud access (design §4,
§12.1), and the worker has to be correct whatever the broker does: it may redeliver a message, deliver it twice,
or deliver an outdated retry.

## Decision

1. **Transport adapter.** Business logic depends on `QueueSender`/`QueueReceiver`
   (`packages/messaging`). Two implementations are provided:
   - `ServiceBusQueue`: Peek-Lock, managed identity via namespace, or a connection string.
   - `PostgresQueue`: a `local_queue_messages` table offering message-ID de-duplication, peek-lock with
     a lock token, abandon with delay, complete and dead-letter.

   `QUEUE_TRANSPORT` selects between them.
2. **Messages carry identifiers, not payloads.** `delivery.requested` v1 is
   `{deliveryId, tenantId, eventId, attempt}`. The worker loads the payload and endpoint from
   PostgreSQL, so endpoint status and URL policy are always current.
3. **Attempt-number fencing.** A message may execute attempt _n_ only if the delivery is `queued`
   with `attempt_count = n − 1`. The claim is a single conditional `UPDATE`. A duplicate or stale message
   claims nothing and is completed. If an identical attempt is still in flight under a live lease, the message is
   abandoned for later.
4. **Retries via a due-work scheduler,** not broker scheduled messages (design §8.3). The worker
   persists `retry_scheduled` + `next_attempt_at`. In one statement, the scheduler flips due rows to
   `queued` and writes a new outbox message for attempt _n + 1_.
5. **Stalled-attempt recovery.** If a worker dies mid-attempt, its delivery lease expires. The scheduler
   returns the delivery to `queued` for the same attempt number.

## Consequences

- All reliability tests run against real PostgreSQL in CI without Azure.
- The local queue is not a production broker. Service Bus behaviour (lock renewal, `MaxDeliveryCount`,
  duplicate detection) still needs its own integration tests.
- The fencing makes worker processing idempotent independent of broker duplicate detection.
