# Receiving RelayForge webhooks

## Request

`POST` to your endpoint URL with a JSON body:

```json
{
  "id": "0c6d7fd0-5381-4f43-b0b1-274b6cf9a3b4",
  "type": "order.created",
  "createdAt": "2026-10-26T13:56:25.191Z",
  "data": { "orderId": "ord_demo_123", "amount": 4999, "currency": "EUR" }
}
```

| Header | Meaning |
| --- | --- |
| `RelayForge-Event-Id` | Stable event ID. **Deduplicate on this.** |
| `RelayForge-Delivery-Id` | One delivery execution (a replay gets a new one). |
| `RelayForge-Attempt` | Attempt number within the delivery, starting at 1. |
| `RelayForge-Timestamp` | Unix seconds when this attempt was signed. |
| `RelayForge-Signature` | `v1=<hex>`. More than one may be comma-separated. |

## Verifying the signature

```
signed_bytes = ASCII(RelayForge-Timestamp) + "." + raw_request_body_bytes
signature    = "v1=" + hex(HMAC_SHA256(key = signing_secret_utf8, signed_bytes))
```

1. Read the **raw** body bytes before any JSON parsing.
2. Reject the request if the timestamp is more than 5 minutes from your clock.
3. Compute the expected signature and compare it to each value in the header using a
   constant-time comparison.

Every retry is re-signed with a fresh timestamp, so old captured requests stop verifying after
the tolerance window.

The reference implementations are `verifySignature` in `packages/security/src/signing.ts` and
`verify` in `tests/webhook-receiver.mjs`.

Test vector: secret `whsec_test`, timestamp `1700000000`, body `{}` →
`v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91`.

## Responding

- Return any **2xx** quickly (within 10 s by default) and process asynchronously.
- **408, 425, 429 and most 5xx responses**, along with timeouts and connection errors, are retried with exponential
  backoff and full jitter. `Retry-After` is honoured for 429/503 (bounded).
- **Other statuses** (other 4xx, 3xx, 501, 505) are permanent failures. Redirects are not followed.
- Delivery is **at-least-once**: the same event can arrive more than once, for example when your
  response is lost. Make your handler idempotent by event ID.
