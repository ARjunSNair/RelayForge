import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Paths that must never reach log output. Payloads are not logged at all;
 * this list is a second line of defence for credentials.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.signingSecret',
  '*.signing_secret',
  '*.apiKey',
  '*.secret',
  'signingSecret',
  'apiKey',
  'secret',
];

export function createLogger(opts: {
  service: string;
  level?: string;
  environment?: string;
}): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { service: opts.service, environment: opts.environment ?? 'development' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
}

/** Map an unknown error to a log-safe object (no request bodies or headers). */
export function errorFields(error: unknown): {
  err_name: string;
  err_message: string;
  err_code?: string;
} {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      err_name: error.name,
      err_message: error.message,
      ...(typeof code === 'string' ? { err_code: code } : {}),
    };
  }
  return { err_name: 'UnknownError', err_message: String(error) };
}
