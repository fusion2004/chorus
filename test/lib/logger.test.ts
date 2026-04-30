import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createActor } from 'xstate';
import {
  debugChannelMachine,
  debugChannelService,
  debugError,
  debugInfo,
  debugWarn,
  logger,
} from '@src/lib/logger.js';

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

describe('debug helpers', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(debugChannelService, 'send');
    infoSpy = vi.spyOn(logger, 'info');
    warnSpy = vi.spyOn(logger, 'warn');
    errorSpy = vi.spyOn(logger, 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a string-only call to the matching pino level and prefixes the Discord message', () => {
    debugInfo('hello world');
    expect(infoSpy).toHaveBeenCalledWith('hello world');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'INFO: hello world',
    });
  });

  it('appends key=value pairs from a merging object as a · suffix', () => {
    debugInfo({ songId: 'abc', count: 3 }, 'state changed');
    expect(infoSpy).toHaveBeenCalledWith({ songId: 'abc', count: 3 }, 'state changed');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'INFO: state changed · songId=abc, count=3',
    });
  });

  it('quotes string values that contain whitespace, commas, or quotes', () => {
    debugWarn({ title: 'Foo Bar', tag: 'plain' }, 'tagged');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'WARN: tagged · title="Foo Bar", tag=plain',
    });
  });

  it('renders arrays compactly without per-element quoting for plain elements', () => {
    debugInfo({ tags: ['ready', 'playing'] }, 'tagged');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'INFO: tagged · tags=[ready,playing]',
    });
  });

  it('reduces Error values to their message and quotes them', () => {
    debugError({ error: new Error('Network timeout') }, 'Party fetch failed');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'ERROR: Party fetch failed · error="Network timeout"',
    });
  });

  it('truncates nested objects to ~200 chars with an ellipsis', () => {
    const big = { data: { payload: 'x'.repeat(500) } };
    debugInfo(big, 'big');
    const lastCall = sendSpy.mock.calls.at(-1);
    if (!lastCall) throw new Error('expected sendSpy to be called');
    const sentMessage = (lastCall[0] as { message: string }).message;
    expect(sentMessage.startsWith('INFO: big · data=')).toBe(true);
    expect(sentMessage.endsWith('...')).toBe(true);
    expect(sentMessage.length).toBeLessThan('INFO: big · data='.length + 210);
  });

  it('passes the merging object straight through to pino', () => {
    debugError({ status: 500 }, 'boom');
    expect(errorSpy).toHaveBeenCalledWith({ status: 500 }, 'boom');
  });

  it('falls back to error.message when given an Error directly with no message arg', () => {
    debugError(new Error('lonely'));
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'ERROR: lonely',
    });
  });

  it('uses the warn channel and prefix for debugWarn', () => {
    debugWarn('something odd');
    expect(warnSpy).toHaveBeenCalledWith('something odd');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      message: 'WARN: something odd',
    });
  });
});
