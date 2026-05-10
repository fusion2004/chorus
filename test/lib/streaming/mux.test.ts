import { describe, it, expect, vi } from 'vitest';

// Mock @mux/mux-node so the SDK doesn't try to read MUX_TOKEN_* at import.
// (The constructor reads env via fetchEnv inside the helpers, but importing
// the module shouldn't require credentials.)
vi.mock('@mux/mux-node', () => ({
  default: vi.fn(),
}));

// Mock @eyevinn/srt similarly. AsyncSRT spawns a worker thread on
// instantiation; we don't want a real worker for unit tests.
vi.mock('@eyevinn/srt', () => ({
  AsyncSRT: vi.fn(),
  setSRTLoggingLevel: vi.fn(),
}));

// Mock fetchEnv so the muxMachine module doesn't blow up if MUX_TOKEN_* aren't
// set in the test environment.
vi.mock('@src/utils/fetch-env.js', () => ({
  fetchEnv: vi.fn((name: string) => `dummy-${name}`),
}));

import { createActor, createMachine, fromPromise, type ActorRefFrom } from 'xstate';
import { muxMachine } from '@src/lib/streaming/mux.js';

const fakeLiveStream = {
  id: 'ls-test-id',
  streamKey: 'sk-test',
  srtPassphrase: 'pp-test',
  playbackId: 'pb-test',
};

const fakeSrtControl = {
  asyncSrt: { close: vi.fn(), dispose: vi.fn(async () => 0) },
  socket: 1,
  getError: () => null,
};

type MuxTestLogic = ReturnType<typeof muxMachine.provide>;

function makeTestLogic(opts?: { neverResolve?: boolean }): MuxTestLogic {
  const streamFile = opts?.neverResolve
    ? fromPromise<{ lastStreamTimeSec: number }, unknown>(() => new Promise(() => {}))
    : fromPromise<{ lastStreamTimeSec: number }, unknown>(async () => ({ lastStreamTimeSec: 0 }));

  return muxMachine.provide({
    actors: {
      createLivestream: fromPromise(async () => ({
        client: {} as never,
        liveStream: fakeLiveStream,
      })),
      connectSrt: fromPromise(async () => fakeSrtControl as never),
      streamFile,
      // tailHold defaults to a 30s sleep — short-circuit it so outro tests
      // don't actually wait.
      tailHold: fromPromise(async () => {}),
      teardown: fromPromise(async () => {}),
    },
  });
}

function spawnInWrapper(logic: MuxTestLogic): {
  child: ActorRefFrom<typeof muxMachine>;
  emitted: { type: string; [key: string]: unknown }[];
} {
  const emitted: { type: string; [key: string]: unknown }[] = [];
  const wrapper = createMachine({
    id: 'testWrapper',
    initial: 'running',
    states: {
      running: {
        invoke: {
          id: 'streamer',
          src: logic,
          input: { round: { fullId: 'OHC123' } },
        },
      },
    },
    on: {
      STREAM_READY: { actions: ({ event }) => emitted.push(event) },
      STREAM_INTRO_DONE: { actions: ({ event }) => emitted.push(event) },
      STREAM_SONG_STARTED: { actions: ({ event }) => emitted.push(event) },
      STREAM_SONG_DONE: { actions: ({ event }) => emitted.push(event) },
      STREAM_OUTRO_DONE: { actions: ({ event }) => emitted.push(event) },
      STREAM_ERROR: { actions: ({ event }) => emitted.push(event) },
    },
  });
  const parent = createActor(wrapper);
  parent.start();
  const child = parent.getSnapshot().children.streamer as ActorRefFrom<typeof muxMachine>;
  return { child, emitted };
}

function waitForState(
  actor: ActorRefFrom<typeof muxMachine>,
  predicate: (state: unknown) => boolean,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate(actor.getSnapshot().value)) {
      resolve();
      return;
    }
    const sub = actor.subscribe((snapshot) => {
      if (predicate(snapshot.value)) {
        sub.unsubscribe();
        clearTimeout(timer);
        resolve();
      }
    });
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(
        new Error(
          `waitForState timeout after ${timeoutMs}ms; current=${JSON.stringify(actor.getSnapshot().value)}`,
        ),
      );
    }, timeoutMs);
  });
}

const songLike: any = { id: 'song-1', path: () => '/tmp/fake.ts' };
const announcerLike = { id: 'outro', path: '/tmp/outro.ts' };

describe('muxMachine', () => {
  it('starts in idle and waits for CONNECT', () => {
    const { child } = spawnInWrapper(makeTestLogic());
    expect(child.getSnapshot().value).toBe('idle');
  });

  it('walks idle → creatingLivestream → connectingSrt → ready on CONNECT, emits STREAM_READY with player URL', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'STREAM_READY',
      url: expect.stringMatching(/^https:\/\/player\.mux\.com\/pb-test\?poster=/),
    });
  });

  it('plays the intro and emits STREAM_INTRO_DONE', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_INTRO' });
    await waitForState(child, (v) => v === 'ready');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_READY', 'STREAM_INTRO_DONE']);
  });

  it('emits STREAM_SONG_STARTED between announcer and song audio', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_SONG', song: songLike });
    await waitForState(child, (v) => v === 'ready');
    expect(emitted.map((e) => e.type)).toEqual([
      'STREAM_READY',
      'STREAM_SONG_STARTED',
      'STREAM_SONG_DONE',
    ]);
  });

  it('SKIP_SONG aborts a pending song and emits STREAM_SONG_DONE', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic({ neverResolve: true }));
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_SONG', song: songLike });
    expect((child.getSnapshot().value as Record<string, string>).playingSong).toBe('announcer');
    child.send({ type: 'SKIP_SONG' });
    await waitForState(child, (v) => v === 'ready');
    expect(emitted.at(-1)?.type).toBe('STREAM_SONG_DONE');
  });

  it('outro flows playingOutro → holding → stopping → stopped, emits STREAM_OUTRO_DONE after the hold', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_OUTRO', announcer: announcerLike });
    await waitForState(child, (v) => v === 'stopped');
    expect(child.getSnapshot().value).toBe('stopped');
    // STREAM_OUTRO_DONE fires from `holding`'s onDone — i.e., after the
    // tail-hold elapses (a no-op in tests). It must come after STREAM_READY.
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_READY', 'STREAM_OUTRO_DONE']);
  });

  it('STOP from any state lands in stopped (via stopping → teardown)', async () => {
    const { child } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'STOP' });
    await waitForState(child, (v) => v === 'stopped');
    expect(child.getSnapshot().value).toBe('stopped');
  });

  it('emits STREAM_ERROR if Mux livestream creation fails', async () => {
    const errorLogic = muxMachine.provide({
      actors: {
        createLivestream: fromPromise<
          { client: never; liveStream: typeof fakeLiveStream },
          unknown
        >(async () => {
          throw new Error('mux api 401');
        }),
        connectSrt: fromPromise(async () => fakeSrtControl as never),
        streamFile: fromPromise(async () => ({ lastStreamTimeSec: 0 })),
        tailHold: fromPromise(async () => {}),
        teardown: fromPromise(async () => {}),
      },
    });
    const { child, emitted } = spawnInWrapper(errorLogic);
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'stopped');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_ERROR']);
    expect(emitted[0]).toMatchObject({
      type: 'STREAM_ERROR',
      reason: 'Mux livestream create failed',
    });
  });

  it('emits STREAM_ERROR if SRT connect fails', async () => {
    const errorLogic = muxMachine.provide({
      actors: {
        createLivestream: fromPromise(async () => ({
          client: {} as never,
          liveStream: fakeLiveStream,
        })),
        connectSrt: fromPromise<typeof fakeSrtControl, unknown>(async () => {
          throw new Error('srt timeout');
        }),
        streamFile: fromPromise(async () => ({ lastStreamTimeSec: 0 })),
        tailHold: fromPromise(async () => {}),
        teardown: fromPromise(async () => {}),
      },
    });
    const { child, emitted } = spawnInWrapper(errorLogic);
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'stopped');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_ERROR']);
    expect(emitted[0]).toMatchObject({
      type: 'STREAM_ERROR',
      reason: 'SRT connect failed',
    });
  });
});
