import { sleep, type QueueReceiver, type ReceivedMessage } from '@relayforge/messaging';
import { errorFields, metrics, type Logger } from '@relayforge/observability';
import type { DeliveryProcessor, Disposition } from './processor.js';

/**
 * Pulls messages with peek-lock and processes up to `concurrency` at a time.
 * A slow destination occupies one slot, not the whole batch.
 */
export class DeliveryWorker {
  constructor(
    private readonly receiver: QueueReceiver,
    private readonly processor: Pick<DeliveryProcessor, 'handle'>,
    private readonly logger: Logger,
    private readonly opts: { concurrency: number; pollIntervalMs: number },
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const inflight = new Set<Promise<void>>();
    while (!signal.aborted) {
      const capacity = this.opts.concurrency - inflight.size;
      if (capacity <= 0) {
        await Promise.race(inflight);
        continue;
      }
      let messages: ReceivedMessage[] = [];
      try {
        messages = await this.receiver.receive(capacity);
      } catch (error) {
        this.logger.error({ ...errorFields(error), operation: 'queue.receive' }, 'receive failed');
      }
      if (messages.length === 0) {
        await sleep(this.opts.pollIntervalMs, signal);
        continue;
      }
      for (const message of messages) {
        const task: Promise<void> = this.process(message).finally(() => inflight.delete(task));
        inflight.add(task);
      }
    }
    await Promise.allSettled(inflight);
  }

  /** Receive and fully process one batch. Used by tests and one-shot runs. */
  async runOnce(maxMessages = this.opts.concurrency): Promise<number> {
    const messages = await this.receiver.receive(maxMessages);
    await Promise.all(messages.map((m) => this.process(m)));
    return messages.length;
  }

  async process(message: ReceivedMessage): Promise<void> {
    metrics.workerActive.inc();
    try {
      await this.#process(message);
    } finally {
      metrics.workerActive.dec();
    }
  }

  async #process(message: ReceivedMessage): Promise<void> {
    let disposition: Disposition;
    try {
      disposition = await this.processor.handle(message);
    } catch (error) {
      // Includes failure to persist the outcome: do not complete the message.
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(message.deliveryCount, 6));
      this.logger.error(
        {
          ...errorFields(error),
          operation: 'delivery.process',
          message_id: message.messageId,
          retry_in_ms: delayMs,
        },
        'processing failed; abandoning message',
      );
      disposition = { action: 'abandon', delayMs };
    }
    try {
      if (disposition.action === 'complete') await this.receiver.complete(message);
      else if (disposition.action === 'abandon')
        await this.receiver.abandon(message, disposition.delayMs);
      else await this.receiver.deadLetter(message, disposition.reason);
    } catch (error) {
      // The lock will expire and the message will be redelivered; processing is idempotent.
      this.logger.error(
        { ...errorFields(error), operation: 'queue.settle', message_id: message.messageId },
        'settle failed',
      );
    }
  }
}
