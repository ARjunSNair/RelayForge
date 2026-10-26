import { safeLookup } from '@relayforge/security';
import { Agent, request } from 'undici';
import type { HttpResult } from './retry-policy.js';

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const MAX_RESPONSE_BYTES = 64 * 1024;

function errorCodeOf(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Outbound webhook client. Redirects are never followed, every phase is
 * bounded by the timeout, response bodies are drained up to a small limit and
 * discarded, and — unless insecure destinations are allowed for local
 * development — DNS answers are validated and pinned by `safeLookup`.
 */
export class WebhookHttpClient {
  readonly #agent: Agent;

  constructor(private readonly opts: { timeoutMs: number; allowInsecure: boolean }) {
    this.#agent = new Agent({
      connect: { timeout: opts.timeoutMs, ...(opts.allowInsecure ? {} : { lookup: safeLookup }) },
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      keepAliveTimeout: 10_000,
      maxRedirections: 0,
    });
  }

  async post(url: URL, headers: Record<string, string>, body: string): Promise<HttpResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const res = await request(url, {
        method: 'POST',
        headers,
        body,
        dispatcher: this.#agent,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      await res.body.dump({ limit: MAX_RESPONSE_BYTES }).catch(() => undefined);
      const retryAfter = res.headers['retry-after'];
      return {
        kind: 'response',
        status: res.statusCode,
        retryAfter: Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
        durationMs: elapsed(),
      };
    } catch (error) {
      const code = errorCodeOf(error);
      const name = (error as { name?: string }).name;
      if (code === 'DESTINATION_BLOCKED')
        return { kind: 'error', code: 'DESTINATION_BLOCKED', durationMs: elapsed() };
      if ((code && TIMEOUT_CODES.has(code)) || name === 'TimeoutError' || name === 'AbortError') {
        return { kind: 'error', code: 'TIMEOUT', durationMs: elapsed() };
      }
      return { kind: 'error', code: 'NETWORK_ERROR', durationMs: elapsed() };
    }
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }
}
