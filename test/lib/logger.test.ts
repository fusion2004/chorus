import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createActor } from 'xstate';
import { debugChannelMachine } from '@src/lib/logger.js';

function stubChannel() {
  return { send: vi.fn().mockResolvedValue(undefined) } as any;
}

function start() {
  const actor = createActor(debugChannelMachine);
  actor.start();
  return actor;
}

describe('debugChannelMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in init and moves to ready when a channel is set', () => {
    const actor = start();
    expect(actor.getSnapshot().value).toBe('init');
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel: stubChannel() });
    expect(actor.getSnapshot().value).toBe('ready');
  });

  it('SEND_MESSAGE moves ready → debouncing, then after 2000ms invokes channel.send with > prefixes', async () => {
    const channel = stubChannel();
    const actor = start();
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel });

    actor.send({ type: 'SEND_MESSAGE', message: 'hello' });
    expect(actor.getSnapshot().value).toBe('debouncing');
    expect(channel.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('> hello');
  });

  it('batches multiple SEND_MESSAGEs received inside the debounce window into a single send', async () => {
    const channel = stubChannel();
    const actor = start();
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel });

    actor.send({ type: 'SEND_MESSAGE', message: 'one' });
    await vi.advanceTimersByTimeAsync(500);
    actor.send({ type: 'SEND_MESSAGE', message: 'two' });
    actor.send({ type: 'SEND_MESSAGE', message: 'three' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('> one\n> two\n> three');
  });

  it('splits newlines within a message into separate > prefixed lines', async () => {
    const channel = stubChannel();
    const actor = start();
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel });

    actor.send({ type: 'SEND_MESSAGE', message: 'line1\nline2' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(channel.send).toHaveBeenCalledWith('> line1\n> line2');
  });

  it('splits batches over 1500 chars across multiple sends; deferred messages stay queued', async () => {
    const channel = stubChannel();
    const actor = start();
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel });

    const big = 'x'.repeat(800);
    actor.send({ type: 'SEND_MESSAGE', message: big });
    actor.send({ type: 'SEND_MESSAGE', message: big });
    actor.send({ type: 'SEND_MESSAGE', message: big });

    await vi.advanceTimersByTimeAsync(2000);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const firstBatch = (channel.send.mock.calls[0] as [string])[0];
    expect(firstBatch.length).toBeLessThan(1500 + 10);
    expect((channel.send.mock.calls[0] as [string])[0].split('\n').length).toBeLessThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('recovers to ready after a send error without crashing', async () => {
    const channel = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('discord blew up'))
        .mockResolvedValue(undefined),
    } as any;
    const actor = start();
    actor.send({ type: 'SET_DEBUG_CHANNEL', channel });

    actor.send({ type: 'SEND_MESSAGE', message: 'boom' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    expect(channel.send).toHaveBeenCalled();
    expect(actor.getSnapshot().status).toBe('active');
    expect(['ready', 'debouncing']).toContain(actor.getSnapshot().value);
  });
});
