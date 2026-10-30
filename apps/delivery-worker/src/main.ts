import { loadWorkerConfig } from '@relayforge/config';
import { createPool } from '@relayforge/database';
import { createQueue } from '@relayforge/messaging';
import { collectProcessMetrics, createLogger, startMetricsServer } from '@relayforge/observability';
import { SecretKeyring } from '@relayforge/security';
import { WebhookHttpClient } from './http-client.js';
import { DeliveryProcessor } from './processor.js';
import { DeliveryWorker } from './worker.js';

const config = loadWorkerConfig();
const logger = createLogger({
  service: 'relayforge-delivery-worker',
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
});
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
// The delivery lease and the queue lock must both outlive one HTTP attempt.
const leaseMs = config.DELIVERY_TIMEOUT_MS + 30_000;
const queue = createQueue(config, pool, leaseMs);
const http = new WebhookHttpClient({
  timeoutMs: config.DELIVERY_TIMEOUT_MS,
  allowInsecure: config.ALLOW_INSECURE_DESTINATIONS,
});

const processor = new DeliveryProcessor({
  pool,
  keyring: new SecretKeyring(
    config.SIGNING_SECRET_ENCRYPTION_KEY_ID,
    config.SIGNING_SECRET_ENCRYPTION_KEY,
    SecretKeyring.parsePrevious(config.SIGNING_SECRET_PREVIOUS_KEYS),
  ),
  http,
  logger,
  leaseMs,
  allowInsecureDestinations: config.ALLOW_INSECURE_DESTINATIONS,
  retry: {
    maxAttempts: config.DELIVERY_MAX_ATTEMPTS,
    maxEventAgeMs: config.DELIVERY_MAX_EVENT_AGE_HOURS * 3_600_000,
    baseDelayMs: config.RETRY_BASE_DELAY_MS,
    maxDelayMs: config.RETRY_MAX_DELAY_MS,
  },
  fairness: {
    endpointDefaultConcurrency: config.ENDPOINT_DEFAULT_CONCURRENCY,
    tenantMaxConcurrency: config.TENANT_MAX_CONCURRENCY,
    deferMs: config.CONCURRENCY_DEFER_MS,
    failureThreshold: config.ENDPOINT_FAILURE_THRESHOLD,
    suspensionMs: config.ENDPOINT_SUSPENSION_MS,
  },
});
const worker = new DeliveryWorker(queue, processor, logger, {
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
});

collectProcessMetrics();
const metricsServer = config.METRICS_PORT
  ? startMetricsServer({ port: config.METRICS_PORT, token: config.METRICS_TOKEN })
  : undefined;

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down; finishing in-flight deliveries');
    shutdown.abort();
  });
}

if (config.ALLOW_INSECURE_DESTINATIONS) {
  logger.warn(
    'ALLOW_INSECURE_DESTINATIONS is enabled: SSRF protections are relaxed (development only)',
  );
}
logger.info(
  { transport: config.QUEUE_TRANSPORT, concurrency: config.WORKER_CONCURRENCY },
  'delivery worker started',
);
await worker.run(shutdown.signal);
await queue.close();
await http.close();
metricsServer?.close();
await pool.end();
logger.info('delivery worker stopped');
