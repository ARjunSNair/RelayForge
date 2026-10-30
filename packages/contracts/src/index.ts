import { z } from 'zod';

// ─── Statuses ────────────────────────────────────────────────────────────

export const DELIVERY_STATUSES = [
  'queued',
  'in_progress',
  'succeeded',
  'retry_scheduled',
  'dead_lettered',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const EVENT_STATUSES = [
  'accepted',
  'processing',
  'completed',
  'failed',
  'partially_delivered',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export type AttemptOutcome = 'succeeded' | 'retryable_failure' | 'permanent_failure';

/** Finite dead-letter reasons (design §8.5). Never free text. */
export type DeadLetterReason =
  | 'MAX_ATTEMPTS'
  | 'EVENT_EXPIRED'
  | 'PERMANENT_FAILURE'
  | 'ENDPOINT_POLICY_BLOCKED'
  | 'INVALID_MESSAGE';

// ─── Queue message contract ──────────────────────────────────────────────

export const DELIVERY_REQUESTED = 'delivery.requested';

/**
 * Body of a `delivery.requested` message, version 1. `attempt` is the attempt
 * number this message is allowed to execute; the worker uses it to fence
 * stale or duplicate messages. Payloads are not carried on the queue.
 */
export const DeliveryRequestedV1 = z.object({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  tenantId: z.string().uuid(),
  eventId: z.string().uuid(),
  attempt: z.number().int().positive(),
});
export type DeliveryRequestedV1 = z.infer<typeof DeliveryRequestedV1>;

// ─── API errors ──────────────────────────────────────────────────────────

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  DELIVERY_NOT_REPLAYABLE: 409,
  CANNOT_REVOKE_CURRENT_KEY: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ENDPOINT_DISABLED: 422,
  NO_ACTIVE_ENDPOINTS: 422,
  DESTINATION_NOT_ALLOWED: 422,
  REPLAY_LIMIT_EXCEEDED: 429,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId?: string };
}

/** An error whose code and message are safe to return to API clients. */
export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERROR_STATUS[code];
  }
}
