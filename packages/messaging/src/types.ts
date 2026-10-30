/**
 * Transport-neutral queue interfaces. Business logic depends only on these,
 * never on Azure SDK types (design §13).
 */

export interface OutgoingMessage {
  /** Stable id; the broker uses it for duplicate detection where supported. */
  messageId: string;
  /** Message type, e.g. `delivery.requested`. */
  subject: string;
  body: unknown;
  correlationId?: string;
  /** W3C trace context, carried as a message property (design §10.3). */
  traceparent?: string;
}

export interface ReceivedMessage {
  messageId: string;
  subject: string;
  body: unknown;
  /** 1 on first delivery; increases on every redelivery. */
  deliveryCount: number;
  correlationId?: string;
  traceparent?: string;
}

export interface QueueSender {
  send(messages: OutgoingMessage[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Peek-lock receiver. A received message stays locked until it is completed,
 * abandoned or dead-lettered; if the lock expires it is redelivered.
 */
export interface QueueReceiver {
  receive(maxMessages: number): Promise<ReceivedMessage[]>;
  complete(message: ReceivedMessage): Promise<void>;
  /** Release the lock so the message is redelivered (after `delayMs` where supported). */
  abandon(message: ReceivedMessage, delayMs?: number): Promise<void>;
  deadLetter(message: ReceivedMessage, reason: string): Promise<void>;
  close(): Promise<void>;
}
