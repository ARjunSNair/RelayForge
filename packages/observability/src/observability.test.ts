import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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
