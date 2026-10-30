# Roadmap

Status against the design document's milestones (§15).

| Milestone | Status |
| --- | --- |
| M0 Skeleton: workspace, strict TS, lint/format, config, Compose, CI | ✅ (iteration 1) |
| M1 API & data model: migrations, tenants/API keys, endpoint CRUD with secret redaction, idempotent event acceptance, OpenAPI | ✅ (iteration 1) |
| M2 Outbox & messaging: transactional outbox, leased publisher with retry, Service Bus adapter, versioned message contract | ✅ (iteration 1). The Service Bus adapter typechecks but has **not yet been run against a real namespace**. |
| M3 Delivery worker: signing, timeouts, attempt persistence, retry scheduling, dead-letter, replay | ✅ (iteration 1) |
| M4 Security & operations | ✅ (iteration 2), except row-level security. See below. |
| M5 Azure deployment | Not started. The Bicep in `infra/` is **not yet aligned** with the app configuration (see below). |
| M6 Portfolio polish | Not started |

## Iteration 2 (this release): operations and security hardening

- **Metrics:** Prometheus metrics from design §10.2 with bounded labels. The API serves `/metrics`; the
  publisher and worker serve it on `METRICS_PORT`. All of them require the `METRICS_TOKEN` bearer token,
  and the endpoint is off when no token is set.
- **Trace propagation:** a W3C `traceparent` travels API → event/outbox row → queue message property → worker →
  outbound webhook request. Retries stay in the original trace. The trace id is in the logs and on each attempt
  (`attempts[].traceId`). Spans are not exported yet (see next iteration).
- **API key management:** `POST/GET/DELETE /v1/api-keys` with the `api_keys:manage` scope. A key can only grant
  scopes it holds itself, and it cannot revoke itself. Creation and revocation are audited.
  `pnpm admin:create-api-key` issues keys for tenants created before this scope existed.
- **Signing-secret overlap:** `rotate-secret` accepts `overlapSeconds` (up to 7 days). During the overlap,
  deliveries carry two signatures (new and previous).
- **Key-versioned encryption at rest:** each endpoint records which data-encryption key sealed its secret
  (`signing_secret_key_id`). `SIGNING_SECRET_PREVIOUS_KEYS` keeps old keys readable, and
  `pnpm admin:rewrap-secrets` re-encrypts everything under the primary key. See
  [the rotation runbook](runbooks/rotate-encryption-key.md).
- **Fairness and endpoint protection** ([ADR-008](decisions/ADR-008-fair-claims-and-endpoint-circuit-breaker.md)):
  per-endpoint (`maxConcurrency`) and per-tenant caps on concurrent attempts, plus a circuit breaker. After
  `ENDPOINT_FAILURE_THRESHOLD` consecutive retryable failures, the endpoint is suspended, then half-opened with one
  probe at a time. Postponed deliveries don't use up attempts.
- **Distributed rate limiting:** per-tenant fixed-window counters in PostgreSQL, shared by every API replica
  (`RATE_LIMIT_STORE=postgres`, the default). It fails open if the counter query fails.
- **Retention:** the publisher deletes finished events older than `RETENTION_EVENT_DAYS`, together with their
  deliveries, attempts and outbox rows. It also deletes published outbox rows, old dead-lettered local
  queue messages and expired rate-limit counters, all in bounded batches. Audit events are kept.

Verified locally: 111 unit and 73 integration tests against PostgreSQL 16. A smoke run of the compiled services
upgraded an iteration-1 database (endpoint secret sealed without a key id), then delivered to it with a valid signature,
kept the caller's trace id end to end, and served protected metrics from all three services.

### Upgrade notes

- Migration `007` assumes iteration-1 secrets were sealed with the key whose id is `k1` (the default
  `SIGNING_SECRET_ENCRYPTION_KEY_ID`). Keep that id until you rotate.
- Existing API keys do **not** gain `api_keys:manage` automatically. Use `pnpm admin:create-api-key --tenant <id>`.
- `RATE_LIMIT_STORE` now defaults to `postgres`: one small write per authenticated request.

## Next iteration

- **Span export:** an OpenTelemetry SDK exporter to Application Insights, built on the propagation that's already in place.
- **Service Bus integration tests** against a real namespace (with duplicate detection enabled), plus
  the `MaxDeliveryCount` and DLQ inspection workflow.
- **Azure (M5):** align the Bicep with the app configuration. That means `DATABASE_URL`,
  `QUEUE_TRANSPORT=servicebus`, the `SERVICE_BUS_NAMESPACE` FQDN, `AZURE_CLIENT_ID` for the user-assigned identity,
  Key Vault secret references for `SIGNING_SECRET_ENCRYPTION_KEY` and `METRICS_TOKEN`, role assignments, and KEDA
  managed-identity auth in place of the missing `servicebus-connection` secret. After that: a migration job,
  GitHub OIDC deployment, and a smoke test in Azure.
- PostgreSQL row-level security as defence in depth.
- A k6 load test report (M6), which will calibrate the fairness defaults and alert thresholds.

## Known limitations

- An event's data is stored as JSONB. Key order and number formatting in the delivered body may differ
  from the submitted JSON. The body is signed exactly as sent.
- A queue message that keeps failing to process (for example, the database is down) is abandoned with
  backoff indefinitely on the PostgreSQL transport. Service Bus caps this with `MaxDeliveryCount`.
- `GET /v1/endpoints` and `GET /v1/api-keys` return the 100 most recent items without pagination.
- A deferred delivery shows as `retry_scheduled` with an unchanged `attemptCount` until it is claimed.
- If a dead-lettered delivery is replayed while retention is deleting its event, the replay can be lost.
  Retention only selects events older than `RETENTION_EVENT_DAYS` (30 by default), so this needs a replay of a
  month-old delivery at exactly the wrong moment.
