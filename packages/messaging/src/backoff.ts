/**
 * Exponential backoff with full jitter: random(0, min(cap, base * 2^(attempt-1))).
 * `attempt` is 1-based (the attempt that just failed).
 */
export function fullJitterBackoff(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/** Resolve after `ms`, or immediately when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
