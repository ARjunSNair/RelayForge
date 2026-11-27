import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createLogger, errorFields, REDACT_PATHS } from './index.js';
import {
  metricsAuthorized,
  registry,
  scrapeGauge,
  startMetricsServer,
  statusClass,
} from './metrics.js';
import { formatTraceparent, parseTraceparent, startSpan } from './trace.js';

describe('trace context', () => {
  const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('parses and formats a W3C traceparent', () => {
    const ctx = parseTraceparent(header);
    expect(ctx).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
    expect(formatTraceparent(ctx!)).toBe(header);
  });

  it('rejects malformed and all-zero ids', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('starts child spans in the parent trace, or a new trace', () => {
    const parent = parseTraceparent(header)!;
    const child = startSpan(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.flags).toBe('01');
    const root = startSpan();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseTraceparent(formatTraceparent(root))).toEqual(root);
  });
});

describe('metrics helpers', () => {
  it('buckets status codes', () => {
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('requires the exact bearer token', () => {
    expect(metricsAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(metricsAuthorized('Bearer s3cre', 's3cret')).toBe(false);
    expect(metricsAuthorized('s3cret', 's3cret')).toBe(false);
    expect(metricsAuthorized(undefined, 's3cret')).toBe(false);
    expect(metricsAuthorized('Bearer ', undefined)).toBe(false);
  });

  it('accepts the Bearer scheme in any case but still rejects malformed headers', () => {
    expect(metricsAuthorized('bearer s3cret', 's3cret')).toBe(true);
    expect(metricsAuthorized('BEARER   s3cret ', 's3cret')).toBe(true);
    expect(metricsAuthorized('Bearer ', 's3cret')).toBe(false);
    expect(metricsAuthorized('Bearer s3cret extra', 's3cret')).toBe(false);
    expect(metricsAuthorized('Basic s3cret', 's3cret')).toBe(false);
  });
});

describe('scrapeGauge', () => {
  it('reads its value at scrape time and replaces a gauge registered under the same name', async () => {
    scrapeGauge('test_scrape_gauge', 'test gauge', async () => 1);
    scrapeGauge('test_scrape_gauge', 'test gauge', async () => 7);
    const body = await registry.metrics();
    expect(body).toContain('test_scrape_gauge 7');
    expect(body).not.toContain('test_scrape_gauge 1\n');
    registry.removeSingleMetric('test_scrape_gauge');
  });
});

describe('startMetricsServer', () => {
  let server: ReturnType<typeof startMetricsServer> | undefined;

  const start = async (token: string | undefined) => {
    server = startMetricsServer({ port: 0, token });
    if (!server.listening) await new Promise((resolve) => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) await new Promise((resolve) => s.close(resolve));
  });

  it('serves liveness without a token and ignores the query string', async () => {
    const base = await start('s3cret');
    const res = await fetch(`${base}/health/live?probe=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('requires the bearer token for /metrics', async () => {
    const base = await start('s3cret');
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer s3cret' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe(registry.contentType);
  });

  it('hides /metrics entirely when no token is configured, and 404s other paths', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe('errorFields', () => {
  it('keeps name and message, and a string code only', () => {
    const err = Object.assign(new TypeError('boom'), { code: 'ECONNRESET' });
    expect(errorFields(err)).toEqual({
      err_name: 'TypeError',
      err_message: 'boom',
      err_code: 'ECONNRESET',
    });
    const numeric = Object.assign(new Error('x'), { code: 42 });
    expect(errorFields(numeric)).toEqual({ err_name: 'Error', err_message: 'x' });
  });

  it('describes non-Error throwables without leaking structure', () => {
    expect(errorFields('nope')).toEqual({ err_name: 'UnknownError', err_message: 'nope' });
  });
});

describe('createLogger', () => {
  it('redacts credentials and tags the service and environment', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    // createLogger writes to stdout; build the same configuration against a sink.
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info(
      { req: { headers: { authorization: 'Bearer s3cret' } }, signingSecret: 'whsec_x' },
      'm',
    );
    const out = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(lines[0]).not.toContain('s3cret');
    expect(lines[0]).not.toContain('whsec_x');
    expect(out.signingSecret).toBe('[REDACTED]');

    const logger = createLogger({ service: 'api', level: 'warn', environment: 'test' });
    expect(logger.level).toBe('warn');
    expect(logger.bindings()).toEqual({ service: 'api', environment: 'test' });
  });
});
