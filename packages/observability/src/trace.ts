import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context (traceparent) propagation, design §10.3. RelayForge does
 * not export spans yet; it carries the trace through the API, outbox, queue
 * message, worker and outbound webhook request so logs, attempt records and
 * the destination's own traces share one trace id.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  /** Two hex digits; 01 = sampled. */
  flags: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO = /^0+$/;

export function parseTraceparent(header: string | undefined | null): TraceContext | null {
  const match = header ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return null;
  return { traceId, spanId, flags };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

/** A new span in `parent`'s trace, or the root of a new sampled trace. */
export function startSpan(parent?: TraceContext | null): TraceContext {
  return {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    flags: parent?.flags ?? '01',
  };
}
