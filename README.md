# RelayForge

Multi-tenant webhook delivery platform: accept events durably, then deliver them to
customer HTTPS endpoints with signing, retries, dead-lettering, replay and delivery history.

This is **iteration 1**, the vertical slice from the
[architecture & implementation design](RelayForge_Architecture_and_Implementation_Design.md) (§20).
It covers milestones 0–1 and the core of milestones 2–3. See [docs/roadmap.md](docs/roadmap.md)
for what is done and what comes next.

```
client ──HTTPS+API key──▶ API ──one transaction──▶ events + deliveries + outbox (PostgreSQL)
                                                          │
                                   outbox publisher (leases, SKIP LOCKED)
                                                          ▼
                              queue (Azure Service Bus | local PostgreSQL queue)
                                                          ▼
               delivery worker (peek-lock, fenced claims) ──signed POST──▶ customer endpoint
                         │ persists attempt + next state, then completes the message
                         ▼
             retry_scheduled ──(scheduler: due → queued + outbox)──▶ next attempt
```

**Delivery semantics:** at-least-once. Receivers must deduplicate by `RelayForge-Event-Id`.

## What works

- **API** (Fastify, Zod-validated, OpenAPI at `/docs`):
  - Endpoint management: create, list, get, patch, and `rotate-secret`. The signing secret is shown once.
  - `POST /v1/events`: idempotent via the `Idempotency-Key` header, and transactional (event, deliveries and outbox rows commit together before the 202).
  - `GET /v1/events/:id`
  - `GET /v1/deliveries`, with cursor pagination
  - `GET /v1/deliveries/:id`, with attempt history
  - `POST /v1/deliveries/:id/replay`
  - `/health/live` and `/health/ready`
- **Outbox publisher:** claims rows with leases (`FOR UPDATE SKIP LOCKED`), publishes using the outbox ID as the message ID, and marks a row published only after the broker acknowledges. If the broker is down, it backs off with jitter. It also runs the **retry scheduler** (due retries → queued) and recovers stalled deliveries.
- **Delivery worker:**
  - Claims each delivery under an attempt-number fence, so stale and duplicate messages can't run an old attempt.
  - Sends an HMAC-SHA256-signed POST with strict timeouts and never follows redirects.
  - Records the attempt and the next state, then completes the message.
  - Handles retries (408/425/429/5xx, timeouts and network errors) with full-jitter backoff and `Retry-After`. 4xx responses and blocked destinations are dead-lettered, and so are deliveries that hit the attempt limit or event age limit.
- **Security:**
  - Hashed API keys with scopes.
  - Signing secrets encrypted at rest.
  - SSRF defences, including DNS pinning at connect time.
  - Tenant isolation, which is tested.
  - Rate limits, an audit log and log redaction.

  See [SECURITY.md](SECURITY.md).

## Quick start (local, no cloud)

Prerequisites: Node.js 22 (20.17+ works), pnpm 9, and PostgreSQL 16 (Docker or local).

```bash
pnpm install
docker compose up -d postgres                  # or point DATABASE_URL at your own PostgreSQL
cp .env.example .env && set -a && . ./.env && set +a
export SIGNING_SECRET_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

pnpm db:migrate
pnpm admin:create-tenant --name "Acme" --test  # prints the API key once
export KEY=rf_test_...

pnpm dev:api        # terminal 1  → http://localhost:3000/docs
pnpm dev:publisher  # terminal 2
pnpm dev:worker     # terminal 3
```

Or run everything in containers with `docker compose up --build`. Then create a tenant from the host with
`DATABASE_URL=postgresql://relayforge:relayforge_dev@localhost:5432/relayforge pnpm admin:create-tenant --name Acme --test`.
Inside Compose, the demo receiver's URL is `http://webhook-receiver:9090/hooks/...`.

### Demo: retries and eventual success

```bash
# 1. Register an endpoint (copy signingSecret from the response; it is never shown again)
curl -s localhost:3000/v1/endpoints -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url":"http://localhost:9090/hooks/flaky","description":"demo"}'

# 2. Start the receiver; it verifies signatures and fails the first two attempts per event
WEBHOOK_SECRET=whsec_... PORT=9090 pnpm receiver

# 3. Publish an event (repeat the exact command: same eventId, no duplicate delivery)
curl -s localhost:3000/v1/events -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: order-123' \
  -d '{"type":"order.created","data":{"orderId":"ord_demo_123","amount":4999,"currency":"EUR"}}'

# 4. Watch it go 500 → 500 → 200
curl -s "localhost:3000/v1/deliveries" -H "authorization: Bearer $KEY"
curl -s "localhost:3000/v1/deliveries/<deliveryId>" -H "authorization: Bearer $KEY"
```

Other receiver paths: `/hooks/fail` (500), `/hooks/reject` (400, dead-lettered immediately and then
replayable), `/hooks/limited` (429 + `Retry-After`) and `/hooks/slow` (timeout). Use a small
`RETRY_BASE_DELAY_MS` (for example 500) to see retries quickly.

## Receiving webhooks

See [docs/webhooks.md](docs/webhooks.md) for headers, the exact signed bytes, and verification.
`tests/webhook-receiver.mjs` is a dependency-free reference verifier.

## Development

| Command | What it does |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | static checks |
| `pnpm test:unit` | fast unit tests (no database) |
| `DATABASE_URL=postgresql://…/relayforge_test pnpm test:integration` | API and pipeline tests against real PostgreSQL. **The schema is dropped and recreated**, and the DB name must contain `test`. |
| `pnpm build` | compile all packages to `dist/` |
| `docker build --build-arg APP=api .` | build an image (`api`, `outbox-publisher`, `delivery-worker`) |

### Layout

```
apps/api               Fastify API (auth, endpoints, events, deliveries, replay)
apps/outbox-publisher  outbox relay + retry scheduler + stalled-delivery recovery
apps/delivery-worker   queue consumer, retry policy, SSRF-safe HTTP client
packages/config        validated environment configuration
packages/contracts     statuses, error envelope, queue message contract (v1)
packages/database      pool, transactions, migrations, shared outbox/status helpers
packages/messaging     queue interfaces + Service Bus and PostgreSQL transports
packages/security      API keys, secret encryption, signing, SSRF policy
packages/observability structured logging with redaction
db/migrations          SQL migrations
tests/integration      API + end-to-end pipeline tests
```

Workspace packages export TypeScript sources under a `source` condition. Dev tools (`tsx`, Vitest,
`tsc --noEmit`) use those sources, and builds use `dist/`.

## Design decisions

The baseline ADRs are in the design document (§16). Decisions made during implementation are in
[docs/decisions](docs/decisions).
