import { describe, it, expect, vi } from 'vitest';

// Mock the libshout binding so the machine's setup({ actions, actors }) and
// its cleanup action don't try to touch real native code at import time.
vi.mock('@fusion2004/nodeshout-koffi', () => ({
  shoutInit: vi.fn(),
  shoutShutdown: vi.fn(),
  createShout: vi.fn(() => ({
    setHost: () => 0,
    setPort: () => 0,
    setUser: () => 0,
    setPassword: () => 0,
    setMount: () => 0,
    setContentFormat: () => 0,
    setMeta: () => 0,
    setAudioInfo: () => 0,
    open: () => 0,
    close: () => 0,
    free: vi.fn(),
    send: () => 0,
    delay: () => 0,
    getError: () => null,
  })),
  ShoutErrorTypes: { SUCCESS: 0 },
  ShoutFormats: { MP3: 1 },
  ShoutUsages: { AUDIO: 1 },
  ShoutMetaKeys: { NAME: 'NAME' },
  ShoutAudioInfoKeys: { BITRATE: 'BITRATE', SAMPLERATE: 'SAMPLERATE', CHANNELS: 'CHANNELS' },
}));

// Mock fetchEnv so the icecast module doesn't blow up if HUBOT_STREAM_* aren't
// set in the test environment (e.g. CI).
vi.mock('@src/utils/fetch-env.js', () => ({
  fetchEnv: vi.fn((name: string) => `dummy-${name}`),
}));

import { createActor, createMachine, fromCallback, fromPromise, type ActorRefFrom } from 'xstate';
import { icecastMachine } from '@src/lib/streaming/icecast.js';

/**
 * Replace the wire-touching actors with fast-resolving stubs so we can
 * exercise state transitions without libshout / file IO. State machine config
 * itself is unchanged — that's what we're testing.
 */
type IcecastTestLogic = ReturnType<typeof icecastMachine.provide>;

function makeTestLogic(opts?: { abortable?: boolean }): IcecastTestLogic {
  // `abortable` mode: the stubs hold open until the context's abort signal
  // fires, then resolve. Mimics the real streamFile's drain-on-abort behaviour
  // so SKIP_SONG tests can drive the abort + drain cycle deterministically.
  const wireStub = opts?.abortable
    ? fromPromise<void, { abortController?: AbortController | null }>(({ input }) => {
        return new Promise<void>((resolve) => {
          const ac = input.abortController;
          if (!ac || ac.signal.aborted) {
            resolve();
            return;
          }
          ac.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })
    : fromPromise<void, unknown>(async () => {});
  return icecastMachine.provide({
    actions: {
      // Real cleanup tries to call shout.close() / free() on a real Shout
      // instance; with our stub object that throws. No-op for tests — we're
      // verifying state-machine wiring, not native cleanup paths.
      cleanup: () => {},
    },
    actors: {
      initNodeshout: fromCallback(({ sendBack }) => {
        sendBack({ type: 'STREAM_OPENED', shout: {}, url: 'http://icecast.test/stream' });
        return () => {};
      }),
      streamIntro: wireStub,
      streamAnnouncer: wireStub,
      streamSongAudio: wireStub,
      streamOutro: wireStub,
    },
  });
}

/**
 * Drive the child machine through a tiny wrapper parent. Without this, the
 * child's sendParent calls throw "Unable to send event to actor '#_parent'".
 * The wrapper also captures every STREAM_* event the child emits so tests
 * can assert on the protocol surface, not just internal state.
 */
function spawnInWrapper(logic: IcecastTestLogic): {
  child: ActorRefFrom<typeof icecastMachine>;
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
  const child = parent.getSnapshot().children.streamer as ActorRefFrom<typeof icecastMachine>;
  return { child, emitted };
}

/** Wait until the actor's value matches the predicate (or time out). */
function waitForState(
  actor: ActorRefFrom<typeof icecastMachine>,
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

const songLike: any = { id: 'song-1', path: () => '/tmp/fake.mp3' };
const announcerLike = { id: 'outro', path: '/tmp/outro.mp3' };

describe('icecastMachine', () => {
  it('starts in idle and waits for CONNECT', () => {
    const { child } = spawnInWrapper(makeTestLogic());
    expect(child.getSnapshot().value).toBe('idle');
  });

  it('opens the connection on CONNECT and emits STREAM_READY', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    expect(child.getSnapshot().value).toBe('ready');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_READY']);
    expect(emitted[0]).toMatchObject({
      type: 'STREAM_READY',
      url: 'http://icecast.test/stream',
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
    // Order: READY → SONG_STARTED → SONG_DONE.
    expect(emitted.map((e) => e.type)).toEqual([
      'STREAM_READY',
      'STREAM_SONG_STARTED',
      'STREAM_SONG_DONE',
    ]);
  });

  it('SKIP_SONG drains the in-flight stream, skips songAudio, and emits STREAM_SONG_DONE', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic({ abortable: true }));
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_SONG', song: songLike });
    // The abortable stub holds the announcer open, so we should see the
    // announcer substate before skipping.
    expect((child.getSnapshot().value as Record<string, string>).playingSong).toBe('announcer');
    child.send({ type: 'SKIP_SONG' });
    // Drain-before-transition: SKIP_SONG itself doesn't change state — it
    // sets the skipping flag and aborts. The stub resolves on abort, then
    // the announcer's onDone branches on skipping=true to land in `ready`.
    await waitForState(child, (v) => v === 'ready');
    // Critically: we must NOT have entered songAudio at any point — the
    // SONG_STARTED emit there would be a giveaway.
    expect(emitted.map((e) => e.type)).not.toContain('STREAM_SONG_STARTED');
    expect(emitted.at(-1)?.type).toBe('STREAM_SONG_DONE');
  });

  it('plays the outro, emits STREAM_OUTRO_DONE, and ends in stopped', async () => {
    const { child, emitted } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'PLAY_OUTRO', announcer: announcerLike });
    await waitForState(child, (v) => v === 'stopped');
    expect(child.getSnapshot().value).toBe('stopped');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_READY', 'STREAM_OUTRO_DONE']);
  });

  it('STOP from any state transitions to stopped', async () => {
    const { child } = spawnInWrapper(makeTestLogic());
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'ready');
    child.send({ type: 'STOP' });
    await waitForState(child, (v) => v === 'stopped');
    expect(child.getSnapshot().value).toBe('stopped');
  });

  it('emits STREAM_ERROR if libshout open fails', async () => {
    const errorLogic = icecastMachine.provide({
      actions: { cleanup: () => {} },
      actors: {
        initNodeshout: fromCallback(({ sendBack }) => {
          sendBack({ type: 'STREAM_OPEN_ERROR', errorCode: 7, message: 'boom' });
          return () => {};
        }),
        streamIntro: fromPromise(async () => {}),
        streamAnnouncer: fromPromise(async () => {}),
        streamSongAudio: fromPromise(async () => {}),
        streamOutro: fromPromise(async () => {}),
      },
    });
    const { child, emitted } = spawnInWrapper(errorLogic);
    child.send({ type: 'CONNECT' });
    await waitForState(child, (v) => v === 'stopped');
    expect(emitted.map((e) => e.type)).toEqual(['STREAM_ERROR']);
    expect(emitted[0]).toMatchObject({ type: 'STREAM_ERROR', reason: 'boom' });
  });
});
