import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { Pool } from '@relayforge/database';

/**
 * Fixed-window rate-limit counters in PostgreSQL, shared by every API replica
 * (the plugin's default store is in-memory per replica). One upsert per
 * request; expired windows are removed by the retention job.
 */
export function postgresRateLimitStore(pool: Pool, prefix = ''): FastifyRateLimitStoreCtor {
  class PostgresRateLimitStore implements FastifyRateLimitStore {
    // The plugin constructs stores as `new Store(globalOptions)`; the prefix is ours.
    constructor(
      _options?: unknown,
      readonly keyPrefix: string = prefix,
    ) {}

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow?: number,
    ): void {
      const windowMs = timeWindow ?? 60_000;
      pool
        .query<{ count: number; ttl: number }>(
          `WITH w AS (
             SELECT to_timestamp(floor(extract(epoch FROM now()) * 1000 / $2) * $2 / 1000) AS start
           )
           INSERT INTO rate_limit_counters (key, window_start, count, expires_at)
           SELECT $1, w.start, 1, w.start + make_interval(secs => $2::double precision / 1000) FROM w
           ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_counters.count + 1
           RETURNING count, greatest(0, extract(epoch FROM expires_at - now()) * 1000)::int AS ttl`,
          [this.keyPrefix + key, windowMs],
        )
        .then(({ rows }) => callback(null, { current: rows[0]!.count, ttl: rows[0]!.ttl }))
        .catch((error: Error) => callback(error));
    }

    /** Used for per-route limits: counters are namespaced by route. */
    child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      // At runtime the plugin passes the route as `routeInfo`, like its Redis store expects.
      const route = (routeOptions as { routeInfo?: { method?: unknown; url?: unknown } }).routeInfo;
      return new PostgresRateLimitStore(
        undefined,
        `${this.keyPrefix}${String(route?.method)}${String(route?.url)}:`,
      );
    }
  }
  return PostgresRateLimitStore;
}
