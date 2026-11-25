import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sender = {
    createMessageBatch: vi.fn(),
    sendMessages: vi.fn(),
    close: vi.fn(),
  };
  const receiver = {
    receiveMessages: vi.fn(),
    completeMessage: vi.fn(),
    abandonMessage: vi.fn(),
    deadLetterMessage: vi.fn(),
    close: vi.fn(),
  };
  const client = {
    createSender: vi.fn(() => sender),
    createReceiver: vi.fn(() => receiver),
    close: vi.fn(),
  };
  return { sender, receiver, client };
});

vi.mock('@azure/service-bus', () => ({ ServiceBusClient: vi.fn(() => mocks.client) }));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }));

import { ServiceBusQueue } from './service-bus-queue.js';

const { sender, receiver, client } = mocks;

/** A batch that accepts `capacity` messages and records what it was given. */
function batch(capacity: number) {
  const added: unknown[] = [];
  return {
    added,
    tryAddMessage: vi.fn((m: unknown) => {
      if (added.length >= capacity) return false;
      added.push(m);
      return true;
    }),
  };
}

function queue(): ServiceBusQueue {
  return new ServiceBusQueue({ queue: 'deliveries', connectionString: 'Endpoint=sb://x/' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ServiceBusQueue.send', () => {
  it('does nothing for an empty list', async () => {
    await queue().send([]);
    expect(client.createSender).not.toHaveBeenCalled();
  });

  it('maps trace context to application properties and omits unset fields', async () => {
    const b = batch(10);
    sender.createMessageBatch.mockResolvedValue(b);
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    await queue().send([
      {
        messageId: 'm1',
        subject: 'delivery.requested',
        body: { a: 1 },
        correlationId: 'c1',
        traceparent,
      },
      { messageId: 'm2', subject: 'delivery.requested', body: {} },
    ]);

    expect(b.added[0]).toEqual({
      messageId: 'm1',
      subject: 'delivery.requested',
      body: { a: 1 },
      contentType: 'application/json',
      correlationId: 'c1',
      applicationProperties: { traceparent, 'Diagnostic-Id': traceparent },
    });
    expect(b.added[1]).not.toHaveProperty('correlationId');
    expect(b.added[1]).not.toHaveProperty('applicationProperties');
    expect(sender.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('starts a new batch when the current one is full', async () => {
    const first = batch(1);
    const second = batch(1);
    sender.createMessageBatch.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await queue().send([
      { messageId: 'm1', subject: 's', body: 1 },
      { messageId: 'm2', subject: 's', body: 2 },
    ]);

    expect(first.added).toHaveLength(1);
    expect(second.added).toHaveLength(1);
    expect(sender.sendMessages.mock.calls.map(([b]) => b)).toEqual([first, second]);
  });

  it('rejects a message that does not fit an empty batch', async () => {
    sender.createMessageBatch.mockResolvedValue(batch(0));
    await expect(queue().send([{ messageId: 'big', subject: 's', body: 1 }])).rejects.toThrow(
      /too large/,
    );
  });
});

describe('ServiceBusQueue receive and settlement', () => {
  const raw = {
    messageId: 'm1',
    subject: 'delivery.requested',
    body: { a: 1 },
    deliveryCount: 3,
    correlationId: 'c1',
    applicationProperties: { traceparent: 'tp' },
  };

  it('maps received messages and defaults missing fields', async () => {
    receiver.receiveMessages.mockResolvedValue([raw, { body: null }]);
    const q = queue();

    const [full, bare] = await q.receive(2);

    expect(full).toEqual({
      messageId: 'm1',
      subject: 'delivery.requested',
      body: { a: 1 },
      deliveryCount: 3,
      correlationId: 'c1',
      traceparent: 'tp',
    });
    expect(bare).toEqual({ messageId: '', subject: '', body: null, deliveryCount: 1 });
    expect(client.createReceiver).toHaveBeenCalledWith('deliveries', { receiveMode: 'peekLock' });
  });

  it('ignores a non-string traceparent property', async () => {
    receiver.receiveMessages.mockResolvedValue([
      { ...raw, applicationProperties: { traceparent: 5 } },
    ]);
    const [m] = await queue().receive(1);
    expect(m).not.toHaveProperty('traceparent');
  });

  it('settles messages against the original broker message', async () => {
    receiver.receiveMessages.mockResolvedValue([raw]);
    const q = queue();
    const [m] = await q.receive(1);

    await q.complete(m!);
    await q.abandon(m!);
    await q.deadLetter(m!, 'poison');

    expect(receiver.completeMessage).toHaveBeenCalledWith(raw);
    expect(receiver.abandonMessage).toHaveBeenCalledWith(raw);
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(raw, {
      deadLetterReason: 'poison',
      deadLetterErrorDescription: 'poison',
    });
  });

  it('refuses to settle before anything was received or for an unknown message', async () => {
    const q = queue();
    const stranger = { messageId: 'x', subject: 's', body: null, deliveryCount: 1 };
    await expect(q.complete(stranger)).rejects.toThrow(/No messages have been received/);

    receiver.receiveMessages.mockResolvedValue([]);
    await q.receive(1);
    await expect(q.complete(stranger)).rejects.toThrow(/Unknown message x/);
  });

  it('closes the sender, receiver and client', async () => {
    sender.createMessageBatch.mockResolvedValue(batch(1));
    receiver.receiveMessages.mockResolvedValue([]);
    const q = queue();
    await q.send([{ messageId: 'm', subject: 's', body: 1 }]);
    await q.receive(1);
    await q.close();
    expect(sender.close).toHaveBeenCalled();
    expect(receiver.close).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });
});
