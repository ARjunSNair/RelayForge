# Roadmap

Status against the design document's milestones (§15).

## Iteration 1 (this release)

| Milestone | Status |
| --- | --- |
| M0 Skeleton: workspace, strict TS, lint/format, config, Compose, CI | ✅ |
| M1 API & data model: migrations, tenants/API keys, endpoint CRUD with secret redaction, idempotent event acceptance, OpenAPI | ✅ |
| M2 Outbox & messaging: transactional outbox, leased publisher with retry, Service Bus adapter, versioned message contract | ✅. The Service Bus adapter typechecks but has **not yet been run against a real namespace**. |
| M3 Delivery worker: signing, timeouts, attempt persistence, retry scheduling, dead-letter, replay | ✅ |
| M4 Security & operations | Partial. Done: SSRF, rate limits, secret encryption, health checks, structured logs, audit log. Not done: see below. |
| M5 Azure deployment | Not started. The Bicep in `infra/` predates this iteration and is **not yet aligned** with the app configuration (e.g. it sets `POSTGRES_HOST` rather than `DATABASE_URL` and lacks `SIGNING_SECRET_ENCRYPTION_KEY`). |
| M6 Portfolio polish | Not started |

Verified locally: 101 unit tests, 56 integration tests against PostgreSQL 16, and a smoke run of
the compiled API, publisher, worker and receiver (500 → 500 → 200 with valid signatures).

## Next iteration

- **Observability:** OpenTelemetry tracing propagated API → outbox → message properties → worker →
  outbound HTTP. Also the metrics listed in design §10.2 (outbox age, queue age, outcomes) and a protected `/metrics` endpoint.
- **Service Bus integration tests** against a real namespace (with duplicate detection enabled), plus
  the `MaxDeliveryCount` and DLQ inspection workflow.
- **Secrets:** source `SIGNING_SECRET_ENCRYPTION_KEY` from Key Vault via managed identity. Add
  key-version tagging on ciphertext for key rotation, and an optional signing-secret overlap window during rotation.
- **Fairness:** per-endpoint and per-tenant delivery concurrency caps, plus temporary endpoint suppression
  (circuit breaking) during sustained failures.
- **Distributed rate limiting:** today's limiter is in-memory, per API replica.
- **Retention jobs** for payloads, attempts, the published outbox and `local_queue_messages`.
- **API key management API** (create/revoke/list). Today keys come from the admin CLI only.
- PostgreSQL Row-Level Security as defence in depth.
- Bicep alignment, GitHub OIDC deployment, and a smoke test in Azure (M5). Then a k6 load test report (M6).

## Known limitations

- An event's data is stored as JSONB. Key order and number formatting in the delivered body may differ
  from the submitted JSON. The body is signed exactly as sent.
- A queue message that keeps failing to process (for example, the database is down) is abandoned with
  backoff indefinitely on the PostgreSQL transport. Service Bus caps this with `MaxDeliveryCount`.
- `GET /v1/endpoints` returns the 100 most recent endpoints without pagination.
