/**
 * Demo webhook receiver and reference signature verifier. No dependencies.
 *
 *   PORT=9090 WEBHOOK_SECRET=whsec_... node tests/webhook-receiver.mjs
 *
 * Paths:
 *   POST /hooks          -> 200
 *   POST /hooks/fail     -> 500 (retryable)
 *   POST /hooks/reject   -> 400 (permanent)
 *   POST /hooks/limited  -> 429 with Retry-After: 5
 *   POST /hooks/flaky    -> 500 for the first two attempts of each event, then 200
 *   POST /hooks/slow     -> 200 after 15 s (exceeds the default 10 s delivery timeout)
 *   GET  /history        -> received deliveries
 *
 * If WEBHOOK_SECRET is set, each request's signature is verified and invalid
 * requests are rejected with 401. Receivers should also deduplicate by
 * RelayForge-Event-Id, because delivery is at-least-once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9090);
const SECRET = process.env.WEBHOOK_SECRET;
const TOLERANCE_SECONDS = 300;

const history = [];
const attemptsByEvent = new Map();

/** Verify `RelayForge-Signature: v1=<hex hmac_sha256(secret, "<timestamp>.<raw body>")>`. */
export function verify(secret, rawBody, signatureHeader, timestampHeader, now = Date.now() / 1000) {
  if (!signatureHeader || !/^\d+$/.test(timestampHeader ?? '')) return false;
  if (Math.abs(now - Number(timestampHeader)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(
    `v1=${createHmac('sha256', secret).update(`${timestampHeader}.`).update(rawBody).digest('hex')}`,
  );
  return signatureHeader
    .split(',')
    .map((s) => Buffer.from(s.trim()))
    .some((c) => c.length === expected.length && timingSafeEqual(c, expected));
}

function log(fields) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    const send = (status, body, headers = {}) => {
      res
        .writeHead(status, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(body));
    };

    if (req.method === 'GET' && path === '/history') return send(200, history);
    if (req.method !== 'POST' || !path.startsWith('/hooks'))
      return send(404, { error: 'not found' });

    const eventId = req.headers['relayforge-event-id'];
    const entry = {
      path,
      eventId,
      deliveryId: req.headers['relayforge-delivery-id'],
      attempt: req.headers['relayforge-attempt'],
      signatureValid: SECRET
        ? verify(
            SECRET,
            raw,
            req.headers['relayforge-signature'],
            req.headers['relayforge-timestamp'],
          )
        : null,
    };
    history.push(entry);
    log({ msg: 'webhook received', ...entry });

    if (entry.signatureValid === false) return send(401, { error: 'invalid signature' });
    switch (path) {
      case '/hooks/fail':
        return send(500, { error: 'simulated failure' });
      case '/hooks/reject':
        return send(400, { error: 'simulated rejection' });
      case '/hooks/limited':
        return send(429, { error: 'slow down' }, { 'retry-after': '5' });
      case '/hooks/flaky': {
        const n = (attemptsByEvent.get(eventId) ?? 0) + 1;
        attemptsByEvent.set(eventId, n);
        return n <= 2 ? send(500, { error: `flaky attempt ${n}` }) : send(200, { received: true });
      }
      case '/hooks/slow':
        return void globalThis.setTimeout(() => send(200, { received: true }), 15_000);
      default:
        return send(200, { received: true });
    }
  });
});

server.listen(PORT, () =>
  log({ msg: `webhook receiver listening on :${PORT}`, verifying: Boolean(SECRET) }),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close(() => process.exit(0)));
