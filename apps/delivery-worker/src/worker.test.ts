import type { QueueReceiver, ReceivedMessage } from '@relayforge/messaging';
import { createLogger } from '@relayforge/observability';
import { describe, expect, it, vi } from 'vitest';
import type { Disposition } from './processor.js';
import { DeliveryWorker } from './worker.js';

const logger = createLogger({ service: 'test', level: 'silent' });

function message(deliveryCount = 1): ReceivedMessage {
  return { messageId: 'm1', subject: 'delivery.requested', body: {}, deliveryCount };
}

function setup(handle: () => Promise<Disposition>, messages: ReceivedMessage[]) {
  const receiver = {
    receive: vi.fn().mockResolvedValue(messages),
    complete: vi.fn().mockResolvedValue(undefined),
    abandon: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } satisfies QueueReceiver;
  const worker = new DeliveryWorker(receiver, { handle }, logger, {
    concurrency: 2,
    pollIntervalMs: 1,
  });
  return { receiver, worker };
}

describe('DeliveryWorker settlement', () => {
  it('completes, abandons with the delay, or dead-letters per the disposition', async () => {
    const complete = setup(async () => ({ action: 'complete' }), [message()]);
    expect(await complete.worker.runOnce()).toBe(1);
    expect(complete.receiver.complete).toHaveBeenCalledTimes(1);

    const abandon = setup(async () => ({ action: 'abandon', delayMs: 250 }), [message()]);
    await abandon.worker.runOnce();
    expect(abandon.receiver.abandon).toHaveBeenCalledWith(expect.anything(), 250);

    const dead = setup(async () => ({ action: 'dead_letter', reason: 'bad' }), [message()]);
    await dead.worker.runOnce();
    expect(dead.receiver.deadLetter).toHaveBeenCalledWith(expect.anything(), 'bad');
  });

  it('abandons with exponential backoff capped at 60s when processing throws', async () => {
    const first = setup(() => Promise.reject(new Error('db down')), [message(1)]);
    await first.worker.runOnce();
    expect(first.receiver.abandon).toHaveBeenCalledWith(expect.anything(), 2_000);

    const late = setup(() => Promise.reject(new Error('db down')), [message(50)]);
    await late.worker.runOnce();
    expect(late.receiver.abandon).toHaveBeenCalledWith(expect.anything(), 60_000);
    expect(late.receiver.complete).not.toHaveBeenCalled();
  });

  it('survives a failed settle so the batch is still counted', async () => {
    const { receiver, worker } = setup(async () => ({ action: 'complete' }), [message()]);
    receiver.complete.mockRejectedValue(new Error('lock lost'));
    await expect(worker.runOnce()).resolves.toBe(1);
  });

  it('run() processes messages until aborted, then drains in-flight work', async () => {
    const controller = new AbortController();
    const { receiver, worker } = setup(async () => {
      controller.abort();
      return { action: 'complete' };
    }, [message()]);
    await worker.run(controller.signal);
    expect(receiver.complete).toHaveBeenCalledTimes(1);
  });
});
