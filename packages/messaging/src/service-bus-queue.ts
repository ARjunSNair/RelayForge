import { DefaultAzureCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
  type ServiceBusSender,
} from '@azure/service-bus';
import type { OutgoingMessage, QueueReceiver, QueueSender, ReceivedMessage } from './types.js';

export interface ServiceBusOptions {
  queue: string;
  /** Preferred: fully qualified namespace, authenticated with managed identity. */
  namespace?: string;
  connectionString?: string;
}

/**
 * Azure Service Bus transport (Peek-Lock). Duplicate detection on the queue is
 * an optimisation only; consumers remain idempotent regardless.
 */
export class ServiceBusQueue implements QueueSender, QueueReceiver {
  readonly #client: ServiceBusClient;
  readonly #raw = new WeakMap<ReceivedMessage, ServiceBusReceivedMessage>();
  #sender: ServiceBusSender | undefined;
  #receiver: ServiceBusReceiver | undefined;

  constructor(private readonly opts: ServiceBusOptions) {
    if (opts.namespace) {
      this.#client = new ServiceBusClient(opts.namespace, new DefaultAzureCredential());
    } else if (opts.connectionString) {
      this.#client = new ServiceBusClient(opts.connectionString);
    } else {
      throw new Error('ServiceBusQueue requires a namespace or connection string');
    }
  }

  async send(messages: OutgoingMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.#sender ??= this.#client.createSender(this.opts.queue);
    let batch = await this.#sender.createMessageBatch();
    for (const m of messages) {
      const message = {
        messageId: m.messageId,
        subject: m.subject,
        body: m.body,
        contentType: 'application/json',
        ...(m.correlationId ? { correlationId: m.correlationId } : {}),
        // Diagnostic-Id is the property Azure SDK instrumentation reads.
        ...(m.traceparent
          ? {
              applicationProperties: { traceparent: m.traceparent, 'Diagnostic-Id': m.traceparent },
            }
          : {}),
      };
      if (!batch.tryAddMessage(message)) {
        await this.#sender.sendMessages(batch);
        batch = await this.#sender.createMessageBatch();
        if (!batch.tryAddMessage(message))
          throw new Error('Message too large for a Service Bus batch');
      }
    }
    await this.#sender.sendMessages(batch);
  }

  async receive(maxMessages: number): Promise<ReceivedMessage[]> {
    this.#receiver ??= this.#client.createReceiver(this.opts.queue, { receiveMode: 'peekLock' });
    const received = await this.#receiver.receiveMessages(maxMessages, { maxWaitTimeInMs: 5_000 });
    return received.map((raw) => {
      const traceparent = raw.applicationProperties?.['traceparent'];
      const message: ReceivedMessage = {
        messageId: String(raw.messageId ?? ''),
        subject: raw.subject ?? '',
        body: raw.body as unknown,
        deliveryCount: raw.deliveryCount ?? 1,
        ...(raw.correlationId ? { correlationId: String(raw.correlationId) } : {}),
        ...(typeof traceparent === 'string' ? { traceparent } : {}),
      };
      this.#raw.set(message, raw);
      return message;
    });
  }

  async complete(message: ReceivedMessage): Promise<void> {
    await this.#requireReceiver().completeMessage(this.#rawOf(message));
  }

  /** Service Bus abandons immediately; `delayMs` is not supported by the broker. */
  async abandon(message: ReceivedMessage): Promise<void> {
    await this.#requireReceiver().abandonMessage(this.#rawOf(message));
  }

  async deadLetter(message: ReceivedMessage, reason: string): Promise<void> {
    await this.#requireReceiver().deadLetterMessage(this.#rawOf(message), {
      deadLetterReason: reason,
      deadLetterErrorDescription: reason,
    });
  }

  async close(): Promise<void> {
    await this.#sender?.close();
    await this.#receiver?.close();
    await this.#client.close();
  }

  #requireReceiver(): ServiceBusReceiver {
    if (!this.#receiver) throw new Error('No messages have been received');
    return this.#receiver;
  }

  #rawOf(message: ReceivedMessage): ServiceBusReceivedMessage {
    const raw = this.#raw.get(message);
    if (!raw) throw new Error(`Unknown message ${message.messageId}`);
    return raw;
  }
}
