import { describe, expect, it } from 'vitest';
import { metricsAuthorized, statusClass } from './metrics.js';
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
