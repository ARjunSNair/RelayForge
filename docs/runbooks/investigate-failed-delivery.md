# Runbook: investigate a failed delivery

You need the event ID or delivery ID. Secrets are never required; they are not readable through the API.

1. **Event overview:** `GET /v1/events/{eventId}` shows the aggregate status and one row per delivery
   execution (replays have `replayOfDeliveryId`).
2. **Attempt history:** `GET /v1/deliveries/{deliveryId}` gives `status`, `deadLetterReason`, and each
   attempt's `httpStatus`, `durationMs` and `errorCode`.

   | errorCode | Meaning | Typical action |
   | --- | --- | --- |
   | `HTTP_5xx`, `HTTP_429`, `TIMEOUT`, `NETWORK_ERROR` | Retryable; the receiver is unhealthy or slow | Wait for retries, or ask the customer to fix and then replay |
   | `HTTP_4xx` (other) | Permanent; the receiver rejected the request | The customer fixes their handler (often signature verification), then replay |
   | `DESTINATION_BLOCKED` | URL or DNS resolves to a non-public address | The endpoint URL must change; it is not replayable until fixed |

   | deadLetterReason | Meaning |
   | --- | --- |
   | `MAX_ATTEMPTS` | Retry budget exhausted |
   | `EVENT_EXPIRED` | Next retry would exceed `DELIVERY_MAX_EVENT_AGE_HOURS` |
   | `PERMANENT_FAILURE` | Non-retryable HTTP status |
   | `ENDPOINT_POLICY_BLOCKED` | SSRF policy refused the destination |

3. **Logs:** filter worker logs on `delivery_id` or `event_id`. Each attempt logs one
   `operation=delivery.attempt` line with `outcome`, `http_status`, `error_code` and `duration_ms`.
   Payloads and credentials are never logged.
4. **Replay:** `POST /v1/deliveries/{deliveryId}/replay` works only for `dead_lettered` deliveries on an active
   endpoint, up to `MAX_REPLAYS_PER_DELIVERY` times. Each replay is a new delivery and is audited.

## Pipeline health

```sql
-- Outbox backlog (should stay near zero; the publisher also logs this every 30 s)
SELECT count(*), now() - min(created_at) AS oldest FROM outbox_events WHERE published_at IS NULL;
-- Rows failing to publish
SELECT last_error_code, count(*) FROM outbox_events WHERE published_at IS NULL GROUP BY 1;
-- Delivery states
SELECT status, count(*) FROM deliveries GROUP BY 1;
-- Stalled attempts (recovered automatically by the publisher's scheduler)
SELECT count(*) FROM deliveries WHERE status = 'in_progress' AND locked_until < now();
```
