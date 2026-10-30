import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (design §10.2). Labels are bounded: never tenant ids,
 * URLs or event ids, which belong in logs and traces.
 */
export const registry = new Registry();

const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];

export const metrics = {
  apiRequests: new Counter({
    name: 'api_requests_total',
    help: 'API requests by route template, method and status class',
    labelNames: ['route', 'method', 'status_class'] as const,
    registers: [registry],
  }),
  apiRequestDuration: new Histogram({
    name: 'api_request_duration_ms',
    help: 'API request duration in milliseconds',
    labelNames: ['route', 'method'] as const,
    buckets: MS_BUCKETS,
    registers: [registry],
  }),
  eventsAccepted: new Counter({
    name: 'events_accepted_total',
    help: 'Events accepted (excluding idempotent replays)',
    registers: [registry],
  }),
  deliveries: new Counter({
    name: 'deliveries_total',
    help: 'Delivery executions finished or rescheduled, by resulting status',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  attemptDuration: new Histogram({
    name: 'delivery_attempt_duration_ms',
    help: 'Outbound webhook attempt duration in milliseconds',
    labelNames: ['outcome'] as const,
    buckets: MS_BUCKETS,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'delivery_retries_total',
    help: 'Attempts that ended with a retry being scheduled',
    registers: [registry],
  }),
  destinationTimeouts: new Counter({
    name: 'destination_timeout_total',
    help: 'Attempts that timed out waiting for the destination',
    registers: [registry],
  }),
  deferrals: new Counter({
    name: 'delivery_deferrals_total',
    help: 'Claims postponed without using an attempt (concurrency caps, suppressed endpoints)',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  endpointSuppressions: new Counter({
    name: 'endpoint_suppressions_total',
    help: 'Times an endpoint circuit breaker opened',
    registers: [registry],
  }),
  workerActive: new Gauge({
    name: 'worker_active_count',
    help: 'Messages currently being processed by this worker',
    registers: [registry],
  }),
  retentionDeleted: new Counter({
    name: 'retention_deleted_rows_total',
    help: 'Rows removed by retention jobs',
    labelNames: ['table'] as const,
    registers: [registry],
  }),
};

let defaultsCollected = false;

/** Process metrics (CPU, memory, event loop lag). Call once per process. */
export function collectProcessMetrics(): void {
  if (defaultsCollected) return;
  defaultsCollected = true;
  collectDefaultMetrics({ register: registry });
}

/** Gauge whose value is computed at scrape time (e.g. from a database query). */
export function scrapeGauge(name: string, help: string, read: () => Promise<number>): Gauge {
  const existing = registry.getSingleMetric(name);
  if (existing) registry.removeSingleMetric(name);
  return new Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      this.set(await read());
    },
  });
}

/** Bounded status label: 2xx, 4xx, 5xx… */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/**
 * True when `authorization` carries `Bearer <token>`. Compared in constant
 * time; a missing configured token never authorises.
 */
export function metricsAuthorized(authorization: string | undefined, token: string | undefined) {
  if (!token || !authorization?.startsWith('Bearer ')) return false;
  const given = Buffer.from(authorization.slice(7).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Minimal metrics/liveness listener for the background services, which have
 * no other HTTP surface. `/metrics` requires the bearer token.
 */
export function startMetricsServer(opts: { port: number; token: string | undefined }): Server {
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (path !== '/metrics' || !opts.token) {
      res.writeHead(404).end();
      return;
    }
    if (!metricsAuthorized(req.headers.authorization, opts.token)) {
      res.writeHead(401).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(opts.port);
  return server;
}
