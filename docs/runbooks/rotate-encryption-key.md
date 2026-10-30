# Runbook: rotate the signing-secret encryption key

Endpoint signing secrets are encrypted at rest (AES-256-GCM) with a data-encryption key. Each row records the id
of the key that sealed it (`webhook_endpoints.signing_secret_key_id`). Rotation can run while the API and
workers are serving traffic, and webhook receivers notice nothing: their signing secrets don't change.

1. **Generate a new key** and store it where the current one lives (in Azure, a Key Vault secret
   referenced by the container apps):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. **Deploy the API and worker with both keys.** Pick a new id; ids are 1–32 characters of `[A-Za-z0-9_-]`.

   ```bash
   SIGNING_SECRET_ENCRYPTION_KEY=<new key>
   SIGNING_SECRET_ENCRYPTION_KEY_ID=k2
   SIGNING_SECRET_PREVIOUS_KEYS=k1:<old key>     # comma-separate if there are several
   ```

   New and rotated endpoint secrets are now sealed with `k2`. Rows sealed with `k1` stay readable.

3. **Rewrap the existing rows** with the same environment:

   ```bash
   pnpm admin:rewrap-secrets      # prints {"rewrapped":N,"remaining":0}
   ```

   It works in batches with `FOR UPDATE SKIP LOCKED`, and you can safely re-run it. If `remaining` isn't 0 (for example,
   rows were locked by a concurrent rotation), run it again.

4. **Confirm that no row uses the old key**, then remove it from `SIGNING_SECRET_PREVIOUS_KEYS` and redeploy:

   ```sql
   SELECT signing_secret_key_id, count(*) FROM webhook_endpoints GROUP BY 1;
   SELECT count(*) FROM webhook_endpoints WHERE previous_signing_secret_key_id = 'k1';
   ```

If a service starts with a key missing, deliveries for the affected endpoints fail with
`Unknown encryption key id`. The queue message is abandoned and retried, not lost. Restore the key and redeploy.

## Rotating one endpoint's signing secret (customer-facing)

That is a different operation: `POST /v1/endpoints/{id}/rotate-secret` with `{"overlapSeconds": 86400}`.
For the overlap period, deliveries are signed with both the new and the previous secret. This gives the
customer time to deploy the new secret before the previous one stops being used.
