import { hostname } from 'node:os';
import { loadPublisherConfig } from '@relayforge/config';
import { createPool } from '@relayforge/database';
import { createQueue, sleep } from '@relayforge/messaging';
import { createLogger, errorFields, type Logger } from '@relayforge/observability';
import { OutboxRelay } from './outbox-relay.js';
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
  reportBacklog(),
]);
await queue.close();
await pool.end();
logger.info('outbox publisher stopped');
