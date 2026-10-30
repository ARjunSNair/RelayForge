import { randomUUID } from 'node:crypto';
import type { Pool } from '@relayforge/database';
import type { OutgoingMessage, QueueReceiver, QueueSender, ReceivedMessage } from './types.js';

/**
 * Local-development transport backed by the `local_queue_messages` table.
 * Provides the subset of Service Bus semantics the worker depends on:
 * message-id de-duplication, peek-lock, abandon, complete and dead-letter.
 */
export class PostgresQueue implements QueueSender, QueueReceiver {
  readonly #locks = new WeakMap<ReceivedMessage, string>();

  constructor(
    private readonly pool: Pool,
    private readonly queue: string,
    private readonly lockDurationMs = 60_000,
  ) {}

  async send(messages: OutgoingMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.pool.query(
      `INSERT INTO local_queue_messages (queue, message_id, body, properties)
       SELECT $1, m.id, m.body, m.props
         FROM unnest($2::text[], $3::jsonb[], $4::jsonb[]) AS m(id, body, props)
       ON CONFLICT (queue, message_id) DO NOTHING`,
      [
        this.queue,
        messages.map((m) => m.messageId),
        messages.map((m) => JSON.stringify(m.body)),
        messages.map((m) =>
          JSON.stringify({
            subject: m.subject,
            correlationId: m.correlationId,
            traceparent: m.traceparent,
          }),
        ),
      ],
    );
  }

  async receive(maxMessages: number): Promise<ReceivedMessage[]> {
    const { rows } = await this.pool.query<{
      message_id: string;
      body: unknown;
      properties: { subject?: string; correlationId?: string; traceparent?: string };
      delivery_count: number;
      lock_token: string;
    }>(
      `UPDATE local_queue_messages q
          SET lock_token = gen_random_uuid(),
              delivery_count = q.delivery_count + 1,
              visible_at = now() + make_interval(secs => $3::double precision / 1000)
        WHERE (q.queue, q.message_id) IN (
                SELECT queue, message_id FROM local_queue_messages
                 WHERE queue = $1 AND dead_lettered_at IS NULL AND visible_at <= now()
                 ORDER BY visible_at
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
      RETURNING q.message_id, q.body, q.properties, q.delivery_count, q.lock_token`,
      [this.queue, maxMessages, this.lockDurationMs],
    );
    return rows.map((r) => {
      const message: ReceivedMessage = {
        messageId: r.message_id,
        subject: r.properties.subject ?? '',
        body: r.body,
        deliveryCount: r.delivery_count,
        ...(r.properties.correlationId ? { correlationId: r.properties.correlationId } : {}),
        ...(r.properties.traceparent ? { traceparent: r.properties.traceparent } : {}),
      };
      this.#locks.set(message, r.lock_token);
      return message;
    });
  }

  async complete(message: ReceivedMessage): Promise<void> {
    await this.pool.query(
      'DELETE FROM local_queue_messages WHERE queue = $1 AND message_id = $2 AND lock_token = $3',
      [this.queue, message.messageId, this.#lockOf(message)],
    );
  }

  async abandon(message: ReceivedMessage, delayMs = 0): Promise<void> {
    await this.pool.query(
      `UPDATE local_queue_messages
          SET lock_token = NULL, visible_at = now() + make_interval(secs => $4::double precision / 1000)
        WHERE queue = $1 AND message_id = $2 AND lock_token = $3`,
      [this.queue, message.messageId, this.#lockOf(message), delayMs],
    );
  }

  async deadLetter(message: ReceivedMessage, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE local_queue_messages
          SET lock_token = NULL, dead_lettered_at = now(), dead_letter_reason = $4
        WHERE queue = $1 AND message_id = $2 AND lock_token = $3`,
      [this.queue, message.messageId, this.#lockOf(message), reason],
    );
  }

  async close(): Promise<void> {
    // The pool is owned by the caller.
  }

  #lockOf(message: ReceivedMessage): string {
    // An unknown message can never match a real lock token.
    return this.#locks.get(message) ?? randomUUID();
  }
}
