import { hostname } from 'node:os';
import { loadPublisherConfig } from '@relayforge/config';
import { createPool } from '@relayforge/database';
import { createQueue, sleep } from '@relayforge/messaging';
import {
  collectProcessMetrics,
  createLogger,
  errorFields,
  metrics,
  scrapeGauge,
  startMetricsServer,
  type Logger,
} from '@relayforge/observability';
import { OutboxRelay } from './outbox-relay.js';
import { runRetention, type RetentionCounts } from './retention.js';
import { enqueueDueRetries, recoverStalledDeliveries } from './retry-scheduler.js';

const config = loadPublisherConfig();
const logger = createLogger({
  service: 'relayforge-outbox-publisher',
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
});
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const queue = createQueue(config, pool);
const owner = `${hostname()}:${process.pid}`;
const relay = new OutboxRelay(pool, queue, logger, {
  owner,
  batchSize: config.OUTBOX_BATCH_SIZE,
  leaseMs: config.OUTBOX_LEASE_MS,
});

// Database-derived gauges are computed per scrape. One publisher replica is
// enough to report them; aggregate with max() if several do.
scrapeGauge('outbox_pending_count', 'Unpublished outbox rows', async () =>
  relay.backlog().then((b) => b.pending),
);
scrapeGauge('outbox_oldest_age_seconds', 'Age of the oldest unpublished outbox row', async () =>
  relay.backlog().then((b) => b.oldestAgeSeconds),
);
scrapeGauge(
  'delivery_queue_age_seconds',
  'Age of the oldest delivery waiting in the queued state',
  async () => {
    const { rows } = await pool.query<{ age: number | null }>(
      `SELECT extract(epoch FROM now() - min(updated_at))::float AS age
         FROM deliveries WHERE status = 'queued'`,
    );
    return Math.round(rows[0]?.age ?? 0);
  },
);
scrapeGauge('dead_letter_count', 'Deliveries currently dead-lettered', async () => {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM deliveries WHERE status = 'dead_lettered'`,
  );
  return rows[0]?.n ?? 0;
});
collectProcessMetrics();
const metricsServer = config.METRICS_PORT
  ? startMetricsServer({ port: config.METRICS_PORT, token: config.METRICS_TOKEN })
  : undefined;

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    shutdown.abort();
  });
}

/** Run `step` repeatedly; go again immediately while it reports a full batch. */
async function loop(
  name: string,
  intervalMs: number,
  full: number,
  step: () => Promise<number>,
  log: Logger,
) {
  while (!shutdown.signal.aborted) {
    let n = 0;
    try {
      n = await step();
    } catch (error) {
      log.error({ ...errorFields(error), operation: name }, 'loop iteration failed');
    }
    if (n < full)
      await sleep(intervalMs + Math.floor(Math.random() * intervalMs * 0.2), shutdown.signal);
  }
}

async function reportBacklog() {
  while (!shutdown.signal.aborted) {
    try {
      logger.info({ operation: 'outbox.backlog', ...(await relay.backlog()) }, 'outbox backlog');
    } catch (error) {
      logger.warn({ ...errorFields(error), operation: 'outbox.backlog' }, 'backlog query failed');
    }
    await sleep(30_000, shutdown.signal);
  }
}

/** Repeat bounded retention passes until one removes nothing. */
async function retentionPass(): Promise<number> {
  const totals: Partial<RetentionCounts> = {};
  let removed = 0;
  for (;;) {
    const counts = await runRetention(pool, {
      eventDays: config.RETENTION_EVENT_DAYS,
      outboxHours: config.RETENTION_OUTBOX_HOURS,
      queueDeadLetterDays: config.RETENTION_QUEUE_DEAD_LETTER_DAYS,
      batchSize: config.RETENTION_BATCH_SIZE,
    });
    let batch = 0;
    for (const [table, n] of Object.entries(counts) as Array<[keyof RetentionCounts, number]>) {
      totals[table] = (totals[table] ?? 0) + n;
      if (n > 0) metrics.retentionDeleted.inc({ table }, n);
      batch += n;
    }
    removed += batch;
    if (batch === 0 || shutdown.signal.aborted) break;
  }
  if (removed > 0)
    logger.info({ operation: 'retention', ...totals }, 'retention pass removed rows');
  return 0;
}

logger.info({ owner, transport: config.QUEUE_TRANSPORT }, 'outbox publisher started');
await Promise.all([
  loop(
    'outbox.relay',
    config.OUTBOX_POLL_INTERVAL_MS,
    config.OUTBOX_BATCH_SIZE,
    () => relay.relayOnce(),
    logger,
  ),
  loop(
    'scheduler.retries',
    config.SCHEDULER_INTERVAL_MS,
    100,
    () => enqueueDueRetries(pool, 100),
    logger,
  ),
  loop(
    'scheduler.recovery',
    config.SCHEDULER_INTERVAL_MS * 5,
    100,
    () => recoverStalledDeliveries(pool, 100),
    logger,
  ),
  loop('retention', config.RETENTION_INTERVAL_MS, 1, retentionPass, logger),
  reportBacklog(),
]);
metricsServer?.close();
await queue.close();
await pool.end();
logger.info('outbox publisher stopped');
