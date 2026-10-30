import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { ApiConfig } from '@relayforge/config';
import { AppError } from '@relayforge/contracts';
import { checkDatabase, type Pool } from '@relayforge/database';
import {
  REDACT_PATHS,
  formatTraceparent,
  metrics,
  metricsAuthorized,
  parseTraceparent,
  registry,
  startSpan,
  statusClass,
  type TraceContext,
} from '@relayforge/observability';
import type { SecretKeyring } from '@relayforge/security';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerAuthentication } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { apiKeyRoutes } from './modules/api-keys.js';
import { deliveryRoutes } from './modules/deliveries.js';
import { endpointRoutes } from './modules/endpoints.js';
import { eventRoutes } from './modules/events.js';
import { postgresRateLimitStore } from './rate-limit-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** This request's span; its traceparent is stored with accepted events. */
    trace: TraceContext;
  }
}

export interface AppDeps {
  pool: Pool;
  config: ApiConfig;
  keyring: SecretKeyring;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, pool } = deps;
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            base: { service: 'relayforge-api', environment: config.NODE_ENV },
            redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          },
    // Envelope allowance on top of the event payload limit, which is enforced precisely per event.
    bodyLimit: config.MAX_EVENT_PAYLOAD_BYTES + 16 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.decorateRequest('trace', null as unknown as TraceContext);
  app.addHook('onRequest', async (request) => {
    request.trace = startSpan(parseTraceparent(request.headers.traceparent as string | undefined));
    request.log = request.log.child({ trace_id: request.trace.traceId });
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('traceparent', formatTraceparent(request.trace));
  });
  app.addHook('onResponse', async (request, reply) => {
    // Route templates only (bounded cardinality); unmatched paths share one label.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    const labels = { route, method: request.method };
    metrics.apiRequests.inc({ ...labels, status_class: statusClass(reply.statusCode) });
    metrics.apiRequestDuration.observe(labels, reply.elapsedTime);
  });
  registerErrorHandling(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RelayForge API',
        version: '1.0.0',
        description: 'Multi-tenant webhook delivery',
      },
      components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_request, reply) => {
    const db = await checkDatabase(pool);
    return reply
      .status(db ? 200 : 503)
      .send({ status: db ? 'ok' : 'unavailable', checks: { database: db } });
  });

  // Prometheus scrape endpoint, protected by METRICS_TOKEN; absent when no token is configured.
  if (config.METRICS_TOKEN) {
    app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
      if (!metricsAuthorized(request.headers.authorization, config.METRICS_TOKEN)) {
        throw new AppError('UNAUTHENTICATED', 'A valid metrics token is required');
      }
      return reply.type(registry.contentType).send(await registry.metrics());
    });
  }

  await app.register(
    async (v1) => {
      registerAuthentication(v1, pool);
      // Keyed by tenant, so it runs after authentication. Counters live in
      // PostgreSQL so the limit holds across replicas.
      await v1.register(rateLimit, {
        hook: 'preHandler',
        ...(config.RATE_LIMIT_STORE === 'postgres'
          ? { store: postgresRateLimitStore(pool, 'tenant:') }
          : {}),
        // Fail open: a counter outage should not take the API down with it.
        skipOnError: true,
        max: config.RATE_LIMIT_MAX,
        timeWindow: config.RATE_LIMIT_WINDOW_MS,
        keyGenerator: (request) => request.auth?.tenantId ?? request.ip,
        errorResponseBuilder: () => new AppError('RATE_LIMITED', 'Rate limit exceeded'),
      });
      await v1.register(endpointRoutes(deps));
      await v1.register(eventRoutes(deps));
      await v1.register(deliveryRoutes(deps));
      await v1.register(apiKeyRoutes(deps));
    },
    { prefix: '/v1' },
  );

  return app;
}
