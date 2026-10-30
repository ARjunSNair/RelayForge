# ADR-008: Fair claims by deferral, and an endpoint circuit breaker

**Status:** Accepted (iteration 2)

## Context

Design §9.4 asks for per-endpoint delivery concurrency limits, and design §11 for isolation between tenants.
Without limits, one tenant with a large burst, or one slow endpoint, can occupy every worker slot. An endpoint
that is down also keeps burning attempts on every queued delivery until each one is dead-lettered.

These limits have to hold across many worker replicas, on both queue transports. Service Bus can't
delay an abandoned message, and every abandon increments `deliveryCount` towards `MaxDeliveryCount`.

## Decision

1. **Caps are checked when a delivery is claimed, in PostgreSQL.** The claim runs in a short transaction. It
   takes a transaction-scoped advisory lock for the tenant, then one for the endpoint (always in that order),
   then counts `in_progress` deliveries whose lease is still live. Two workers therefore can't both take
   the last slot. The limits are the endpoint's `max_concurrency` (default `ENDPOINT_DEFAULT_CONCURRENCY`) and
   `TENANT_MAX_CONCURRENCY`.
2. **A claim that can't proceed is deferred, not abandoned.** The delivery moves from `queued` back to
   `retry_scheduled`, with `next_attempt_at` set a short, jittered time ahead. Its `attempt_count` is left unchanged,
   and the message is completed. The existing scheduler then re-sends a message for **the same attempt number**,
   so deferral doesn't consume the retry budget or the broker's delivery count. Fencing from ADR-007 still applies.
3. **Circuit breaker per endpoint.** Retryable failures (timeouts, network errors, 429, most 5xx) increment
   `consecutive_failures`, in the same transaction that records the attempt. A success resets the count to zero.
   Permanent failures don't count, because they are usually specific to one event. When the count reaches
   `ENDPOINT_FAILURE_THRESHOLD`, `suppressed_until` is set `ENDPOINT_SUSPENSION_MS` ahead, and claims are deferred
   until then.
4. **Half-open.** After the suspension ends, an endpoint whose count is still at or above the threshold has an effective
   concurrency of 1. One probe runs at a time. A failure re-opens the breaker immediately; a success closes it.
5. **Operator override.** `PATCH /v1/endpoints/:id` with `status: active` clears the breaker. Health is visible on the
   endpoint (`health.consecutiveFailures`, `health.suppressedUntil`). The `delivery_deferrals_total{reason}` and
   `endpoint_suppressions_total` metrics show how often each mechanism triggers.

## Consequences

- Throughput for a single endpoint is bounded by design. Defaults (4 per endpoint, 32 per tenant) are
  starting points until the M6 load test calibrates them.
- A deferred delivery makes an extra round trip through the outbox and queue. That is cheap relative to an HTTP
  attempt, and it keeps workers busy with deliveries they can actually run.
- Event age still applies: a delivery deferred past `DELIVERY_MAX_EVENT_AGE_HOURS` is dead-lettered as
  `EVENT_EXPIRED` when it is next claimed.
- Advisory-lock keys are hashes, so an unrelated tenant or endpoint can occasionally share a lock. That only
  adds serialisation. The claim transaction holds no lock across network I/O.
