import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../apps/api/src/app.js';
import { createTenantWithApiKey } from '../../apps/api/src/tenants.js';
import { loadApiConfig } from '@relayforge/config';
import { createPool, type Pool } from '@relayforge/database';
import { WebhookHttpClient } from '../../apps/delivery-worker/src/http-client.js';
import {
  DEFAULT_FAIRNESS,
  DeliveryProcessor,
  type FairnessSettings,
} from '../../apps/delivery-worker/src/processor.js';
import { DeliveryWorker } from '../../apps/delivery-worker/src/worker.js';
import { PostgresQueue, type QueueSender } from '@relayforge/messaging';
import { createLogger } from '@relayforge/observability';
import { OutboxRelay } from '../../apps/outbox-publisher/src/outbox-relay.js';
import { SecretKeyring } from '@relayforge/security';

export const ENCRYPTION_KEY = randomBytes(32).toString('base64');
export const keyring = new SecretKeyring('k1', ENCRYPTION_KEY);
export const logger = createLogger({ service: 'test', level: 'silent' });

export function testPool(): Pool {
  return createPool(process.env['DATABASE_URL']!, 5);
}

export async function resetData(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE rate_limit_counters, local_queue_messages, audit_events, delivery_attempts, deliveries, outbox_events,
    events, webhook_endpoints, api_keys, tenants CASCADE`);
}

export async function makeApi(
  pool: Pool,
  overrides: Record<string, string> = {},
): ReturnType<typeof buildApp> {
  const config = loadApiConfig({
    DATABASE_URL: process.env['DATABASE_URL'],
    SIGNING_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ALLOW_INSECURE_DESTINATIONS: 'true',
    RATE_LIMIT_STORE: 'memory',
    ...overrides,
  });
  const app = await buildApp({ pool, config, keyring });
  await app.ready();
  return app;
}

export async function makeTenant(pool: Pool, name = 'Acme', scopes?: string[]) {
  const t = await createTenantWithApiKey(pool, name, {
    mode: 'test',
    ...(scopes ? { scopes } : {}),
  });
  return { ...t, headers: { authorization: `Bearer ${t.apiKey}` } };
}

// ─── Controllable webhook receiver ──────────────────────────────────────

export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  #replies: Reply[] = [];
  #fallback: Reply = { status: 200 };
  #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<Receiver> {
    const receiver: Receiver = new Receiver(
      createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          receiver.requests.push({
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          const reply = receiver.#replies.shift() ?? receiver.#fallback;
          const send = () => {
            if (res.destroyed) return;
            res.writeHead(reply.status, reply.headers).end('ok');
          };
          if (reply.delayMs) setTimeout(send, reply.delayMs);
          else send();
        });
      }),
    );
    await new Promise<void>((resolve) => receiver.#server.listen(0, '127.0.0.1', resolve));
    return receiver;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/hooks`;
  }

  /** Queue one-shot replies; afterwards every request gets `fallback`. */
  reply(...replies: Reply[]): this {
    this.#replies.push(...replies);
    return this;
  }

  always(reply: Reply): this {
    this.#fallback = reply;
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.#replies = [];
    this.#fallback = { status: 200 };
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

// ─── Pipeline (publisher + worker) wired to the Postgres queue ───────────

export interface PipelineOptions {
  sender?: QueueSender;
  timeoutMs?: number;
  maxAttempts?: number;
  allowInsecure?: boolean;
  now?: () => number;
  fairness?: Partial<FairnessSettings>;
  random?: () => number;
}

export function makePipeline(pool: Pool, opts: PipelineOptions = {}) {
  const queue = new PostgresQueue(pool, 'test-deliveries', 30_000);
  const relay = new OutboxRelay(pool, opts.sender ?? queue, logger, {
    owner: 'test',
    batchSize: 100,
    leaseMs: 30_000,
  });
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const http = new WebhookHttpClient({ timeoutMs, allowInsecure: opts.allowInsecure ?? true });
  const processor = new DeliveryProcessor({
    pool,
    keyring,
    http,
    logger,
    leaseMs: timeoutMs + 5_000,
    allowInsecureDestinations: opts.allowInsecure ?? true,
    retry: {
      maxAttempts: opts.maxAttempts ?? 3,
      maxEventAgeMs: 3_600_000,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
    },
    fairness: { ...DEFAULT_FAIRNESS, ...opts.fairness },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });
  const worker = new DeliveryWorker(queue, processor, logger, {
    concurrency: 10,
    pollIntervalMs: 10,
  });

  return {
    queue,
    relay,
    processor,
    worker,
    /** Relay the outbox, then let the worker process everything it receives. */
    async pump(): Promise<number> {
      await relay.relayOnce();
      return worker.runOnce(50);
    },
    async close() {
      await http.close();
    },
  };
}

/** Make every retry_scheduled delivery due now. */
export async function makeRetriesDue(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'retry_scheduled'`,
  );
}
