import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const commonShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10),
  QUEUE_TRANSPORT: z.enum(['postgres', 'servicebus']).default('postgres'),
  QUEUE_NAME: z.string().min(1).default('relayforge-deliveries'),
  /** Fully qualified namespace, e.g. relayforge-dev.servicebus.windows.net (managed identity). */
  SERVICE_BUS_NAMESPACE: z.string().optional(),
  /** Connection string alternative for local use against a real namespace. */
  SERVICE_BUS_CONNECTION_STRING: z.string().optional(),
  /**
   * Development/test escape hatch: allow http:// and private-network webhook
   * destinations (e.g. a receiver on localhost). Refused in production.
   */
  ALLOW_INSECURE_DESTINATIONS: bool,
};

/** 32-byte AES-256-GCM key, base64 encoded. */
const encryptionKey = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a base64-encoded 32-byte key');

const apiSchema = z.object({
  ...commonShape,
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000),
  SIGNING_SECRET_ENCRYPTION_KEY: encryptionKey,
  MAX_EVENT_PAYLOAD_BYTES: int(256 * 1024),
  RATE_LIMIT_MAX: int(600),
  RATE_LIMIT_WINDOW_MS: int(60_000),
  MAX_REPLAYS_PER_DELIVERY: int(5),
});

const publisherSchema = z.object({
  ...commonShape,
  OUTBOX_POLL_INTERVAL_MS: int(500),
  OUTBOX_BATCH_SIZE: int(100),
  OUTBOX_LEASE_MS: int(30_000),
  SCHEDULER_INTERVAL_MS: int(1_000),
});

const workerSchema = z.object({
  ...commonShape,
  SIGNING_SECRET_ENCRYPTION_KEY: encryptionKey,
  WORKER_CONCURRENCY: int(8),
  WORKER_POLL_INTERVAL_MS: int(500),
  DELIVERY_TIMEOUT_MS: int(10_000),
  DELIVERY_MAX_ATTEMPTS: int(8),
  DELIVERY_MAX_EVENT_AGE_HOURS: int(72),
  RETRY_BASE_DELAY_MS: int(5_000),
  RETRY_MAX_DELAY_MS: int(60 * 60 * 1000),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type PublisherConfig = z.infer<typeof publisherSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type CommonConfig = z.infer<z.ZodObject<typeof commonShape>>;

type Env = Record<string, string | undefined>;

function parse<T extends CommonConfig>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, env: Env): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report variable names only; never echo values, which may be secrets.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const config = result.data;
  if (config.NODE_ENV === 'production' && config.ALLOW_INSECURE_DESTINATIONS) {
    throw new Error(
      'Invalid configuration: ALLOW_INSECURE_DESTINATIONS cannot be enabled in production',
    );
  }
  if (
    config.QUEUE_TRANSPORT === 'servicebus' &&
    !config.SERVICE_BUS_NAMESPACE &&
    !config.SERVICE_BUS_CONNECTION_STRING
  ) {
    throw new Error(
      'Invalid configuration: QUEUE_TRANSPORT=servicebus requires SERVICE_BUS_NAMESPACE or SERVICE_BUS_CONNECTION_STRING',
    );
  }
  return config;
}

export const loadApiConfig = (env: Env = process.env): ApiConfig => parse(apiSchema, env);
export const loadPublisherConfig = (env: Env = process.env): PublisherConfig =>
  parse(publisherSchema, env);
export const loadWorkerConfig = (env: Env = process.env): WorkerConfig => parse(workerSchema, env);
