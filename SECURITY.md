# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") for this repository.

## Controls implemented in this iteration

| Control | Where |
| --- | --- |
| API keys stored as SHA-256 hashes of 256-bit random secrets; shown once | `packages/security/src/api-keys.ts` |
| API key self-service without privilege escalation (granted scopes ⊆ caller's scopes; no self-revocation); creation and revocation audited | `apps/api/src/modules/api-keys.ts` |
| Endpoint signing secrets encrypted at rest (AES-256-GCM), never returned after creation/rotation | `packages/security/src/secret-box.ts` |
| Data-encryption key rotation: key id stored per row, previous keys read-only, online rewrap | `SecretKeyring`, `apps/api/src/key-rotation.ts`, [runbook](docs/runbooks/rotate-encryption-key.md) |
| Signing-secret rotation with a bounded overlap window (≤ 7 days, dual signatures) | `apps/api/src/modules/endpoints.ts` |
| HMAC-SHA256 request signatures over `timestamp.body`, constant-time verification | `packages/security/src/signing.ts` |
| SSRF: https only, no URL credentials, private/reserved/metadata ranges blocked (incl. IPv4-mapped IPv6, NAT64, Azure WireServer), DNS answers validated and pinned at connect time, redirects never followed, policy re-checked on every attempt | `packages/security/src/ssrf.ts`, `apps/delivery-worker/src/http-client.ts` |
| Tenant derived only from the credential; tenant predicate in every query; cross-tenant access returns 404 | `apps/api/src/auth.ts`, `tests/integration/api.int.test.ts` |
| Scoped API keys, revocation, expiry, tenant suspension | `apps/api/src/auth.ts` |
| Payload size and JSON depth limits, bounded page sizes, per-tenant rate limit shared across replicas, bounded replays | `apps/api/src/modules/*`, `apps/api/src/rate-limit-store.ts` |
| Per-endpoint and per-tenant delivery concurrency caps; failing endpoints suspended | `apps/delivery-worker/src/processor.ts`, ADR-008 |
| Retention of payloads and delivery history | `apps/outbox-publisher/src/retention.ts` |
| `/metrics` requires a bearer token (constant-time compare); metric labels never contain tenant ids, URLs or event ids | `packages/observability/src/metrics.ts` |
| Log redaction of credentials; payloads never logged | `packages/observability` |
| Audit trail for endpoint changes, secret rotation, replay and API key creation/revocation | `audit_events` table |

`ALLOW_INSECURE_DESTINATIONS=true` relaxes SSRF checks for local development and is
rejected at startup when `NODE_ENV=production`.

See design document §9 for the full threat model and the [roadmap](docs/roadmap.md) for
controls not yet implemented (Key Vault references in the Azure deployment, row-level security).
