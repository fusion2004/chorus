/**
 * Icecast streaming child machine. Owns the libshout connection and the
 * file-streaming loop; the parent partyService speaks to it via the events
 * defined in `./types.ts`.
 *
 * Lifted (with minimal restructuring) from the inline streaming substates
 * that previously lived in src/lib/party.ts. Two notable changes:
 *   - The connection isn't opened until the parent sends CONNECT (explicit
 *     handshake instead of auto-connecting on spawn). This matches today's
 *     behaviour of waiting for announcer generation to finish.
 *   - playCurrentSong is split into an `announcer` substate followed by a
 *     `songAudio` substate so the machine can emit SONG_STARTED between
 *     them — the parent uses that to time the "now playing" Discord message.
 */

import fs from 'node:fs';
import {
  shoutInit,
  shoutShutdown,
  createShout,
  ShoutErrorTypes,
  ShoutFormats,
  ShoutUsages,
  ShoutMetaKeys,
  ShoutAudioInfoKeys,
} from '@fusion2004/nodeshout-koffi';
import type { Shout } from '@fusion2004/nodeshout-koffi';
import { setup, assign, fromPromise, fromCallback, sendParent } from 'xstate';

import { announcerFinal, transcodeFinal } from '../../utils/symbols.js';
import { fetchEnv } from '../../utils/fetch-env.js';
import { logger, debugError } from '../logger.js';
import type { Song } from '../song.js';
import type { ExtraAnnouncer, StreamingInput, StreamingInputEvent } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const STREAM = {
  host: fetchEnv('HUBOT_STREAM_HOST'),
  port: parseInt(fetchEnv('HUBOT_STREAM_PORT'), 10),
  mount: fetchEnv('HUBOT_STREAM_MOUNT'),
  password: fetchEnv('HUBOT_STREAM_SOURCE_PASSWORD'),
};

function streamUrl(): string {
  return `${fetchEnv('ICECAST_ORIGIN')}/${STREAM.mount}`;
}

function checkShout(shout: Shout, status: number, op: string): void {
  if (status !== ShoutErrorTypes.SUCCESS) {
    throw new Error(`libshout ${op} failed: error ${status} ${shout.getError()}`);
  }
}

async function streamFile(shout: Shout, filePath: string, signal: AbortSignal): Promise<void> {
  const fileHandle = await fs.promises.open(filePath);
  const chunkSize = 65536;
  const buf = Buffer.alloc(chunkSize);

  try {
    while (true) {
      if (signal.aborted) return;
      const { bytesRead } = await fileHandle.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      checkShout(shout, shout.send(buf, bytesRead), 'send');
      const delay = shout.delay();
      if (delay > 0) await sleep(delay);
    }
  } finally {
    await fileHandle.close();
  }
}

interface IcecastContext {
  round: { fullId: string };
  shout: Shout | null;
  abortController: AbortController | null;
  currentSong: Song | null;
  outroAnnouncer: ExtraAnnouncer | null;
  /**
   * Drain-before-transition flag. SKIP_SONG aborts the abort-controller and
   * sets this; the in-flight streamFile finishes naturally and the announcer
   * state's onDone/onError branches on this flag to skip the songAudio half
   * entirely. Mirrors the pattern in muxMachine — libshout's writes are
   * synchronous so the concurrent-write hazard doesn't apply here, but
   * keeping behaviour identical between the two backends is worth it.
   */
  skipping: boolean;
}

type IcecastInternalEvent =
  | { type: 'STREAM_OPENED'; shout: Shout; url: string }
  | { type: 'STREAM_OPEN_ERROR'; errorCode: number; message?: string };

type IcecastEvent = StreamingInputEvent | IcecastInternalEvent;

function actorErrorMessage(event: unknown): string {
  const err = (event as { error?: unknown }).error;
  return (err as { message?: string })?.message ?? String(err);
}

export const icecastMachine = setup({
  types: {
    input: {} as StreamingInput,
    context: {} as IcecastContext,
    events: {} as IcecastEvent,
  },
  actions: {
    cleanup: ({ context }) => {
      if (context.abortController) {
        logger.info('Aborting the current audio pipeline');
        context.abortController.abort();
      }
      if (context.shout) {
        logger.info('Closing nodeshout connection');
        const status = context.shout.close();
        if (status !== ShoutErrorTypes.SUCCESS) {
          debugError(`libshout close failed: error ${status} ${context.shout.getError()}`);
        }
        context.shout.free();
        shoutShutdown();
      }
    },
  },
  actors: {
    initNodeshout: fromCallback<IcecastInternalEvent, IcecastContext>(({ sendBack, input }) => {
      shoutInit();
      const shout: Shout = createShout();
      try {
        checkShout(shout, shout.setHost(STREAM.host), 'setHost');
        checkShout(shout, shout.setPort(STREAM.port), 'setPort');
        checkShout(shout, shout.setUser('source'), 'setUser');
        checkShout(shout, shout.setPassword(STREAM.password), 'setPassword');
        checkShout(shout, shout.setMount(STREAM.mount), 'setMount');
        checkShout(
          shout,
          shout.setContentFormat(ShoutFormats.MP3, ShoutUsages.AUDIO, null),
          'setContentFormat',
        );
        checkShout(
          shout,
          shout.setMeta(ShoutMetaKeys.NAME, `${input.round.fullId} Listening Party`),
          'setMeta(NAME)',
        );
        checkShout(
          shout,
          shout.setAudioInfo(ShoutAudioInfoKeys.BITRATE, '320'),
          'setAudioInfo(bitrate)',
        );
        checkShout(
          shout,
          shout.setAudioInfo(ShoutAudioInfoKeys.SAMPLERATE, '44100'),
          'setAudioInfo(samplerate)',
        );
        checkShout(
          shout,
          shout.setAudioInfo(ShoutAudioInfoKeys.CHANNELS, '2'),
          'setAudioInfo(channels)',
        );

        const status = shout.open();
        if (status === ShoutErrorTypes.SUCCESS) {
          sendBack({ type: 'STREAM_OPENED', shout, url: streamUrl() });
        } else {
          const detail = `error ${status} ${shout.getError()}`;
          shout.free();
          shoutShutdown();
          sendBack({ type: 'STREAM_OPEN_ERROR', errorCode: status, message: detail });
        }
      } catch (err) {
        shout.free();
        shoutShutdown();
        sendBack({
          type: 'STREAM_OPEN_ERROR',
          errorCode: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return () => {};
    }),
    streamIntro: fromPromise<void, IcecastContext>(({ input }) =>
      streamFile(input.shout!, './audio/intro01.mp3', input.abortController!.signal),
    ),
    streamAnnouncer: fromPromise<void, IcecastContext>(({ input }) =>
      streamFile(
        input.shout!,
        input.currentSong!.path(announcerFinal),
        input.abortController!.signal,
      ),
    ),
    streamSongAudio: fromPromise<void, IcecastContext>(({ input }) =>
      streamFile(
        input.shout!,
        input.currentSong!.path(transcodeFinal),
        input.abortController!.signal,
      ),
    ),
    streamOutro: fromPromise<void, IcecastContext>(({ input }) =>
      streamFile(input.shout!, input.outroAnnouncer!.path, input.abortController!.signal),
    ),
  },
}).createMachine({
  id: 'icecastStreaming',
  initial: 'idle',
  context: ({ input }): IcecastContext => ({
    round: input.round,
    shout: null,
    abortController: null,
    currentSong: null,
    outroAnnouncer: null,
    skipping: false,
  }),
  on: {
    STOP: { target: '.stopped' },
  },
  states: {
    idle: {
      on: { CONNECT: 'opening' },
    },
    opening: {
      invoke: { src: 'initNodeshout', input: ({ context }) => context },
      on: {
        STREAM_OPENED: {
          target: 'ready',
          actions: [
            assign(({ event }) => ({ shout: event.shout })),
            sendParent(({ event }) => ({ type: 'STREAM_READY', url: event.url })),
          ],
        },
        STREAM_OPEN_ERROR: {
          target: 'stopped',
          actions: [
            ({ event }) =>
              debugError(`libshout open failed: ${event.message ?? `errno ${event.errorCode}`}`),
            sendParent(({ event }) => ({
              type: 'STREAM_ERROR',
              reason: event.message ?? `errno ${event.errorCode}`,
            })),
          ],
        },
      },
    },
    ready: {
      on: {
        PLAY_INTRO: {
          target: 'playingIntro',
          actions: assign(() => ({ abortController: new AbortController() })),
        },
        PLAY_SONG: {
          target: 'playingSong',
          actions: assign(({ event }) => ({
            currentSong: event.song,
            abortController: new AbortController(),
          })),
        },
        PLAY_OUTRO: {
          target: 'playingOutro',
          actions: assign(({ event }) => ({
            outroAnnouncer: event.announcer,
            abortController: new AbortController(),
          })),
        },
      },
    },
    playingIntro: {
      invoke: {
        id: 'streamIntro',
        src: 'streamIntro',
        input: ({ context }) => context,
        onDone: {
          target: 'ready',
          actions: sendParent({ type: 'STREAM_INTRO_DONE' }),
        },
        onError: {
          target: 'stopped',
          actions: [
            ({ event }) => debugError(`streamIntro: ${actorErrorMessage(event)}`),
            sendParent({ type: 'STREAM_ERROR', reason: 'streamIntro failed' }),
          ],
        },
      },
      on: {
        SKIP_SONG: {
          target: 'ready',
          actions: [
            ({ context }) => context.abortController?.abort(),
            sendParent({ type: 'STREAM_INTRO_DONE' }),
          ],
        },
      },
    },
    playingSong: {
      // Reset skipping each time we enter — see IcecastContext doc.
      entry: assign({ skipping: false }),
      initial: 'announcer',
      states: {
        announcer: {
          invoke: {
            id: 'streamAnnouncer',
            src: 'streamAnnouncer',
            input: ({ context }) => context,
            onDone: [
              {
                guard: ({ context }) => context.skipping,
                target: '#icecastStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              { target: 'songAudio' },
            ],
            onError: [
              {
                guard: ({ context }) => context.skipping,
                target: '#icecastStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              {
                target: '#icecastStreaming.stopped',
                actions: [
                  ({ event }) => debugError(`streamAnnouncer: ${actorErrorMessage(event)}`),
                  sendParent({ type: 'STREAM_ERROR', reason: 'streamAnnouncer failed' }),
                ],
              },
            ],
          },
        },
        songAudio: {
          entry: sendParent({ type: 'STREAM_SONG_STARTED' }),
          invoke: {
            id: 'streamSongAudio',
            src: 'streamSongAudio',
            input: ({ context }) => context,
            onDone: {
              target: '#icecastStreaming.ready',
              actions: sendParent({ type: 'STREAM_SONG_DONE' }),
            },
            onError: [
              {
                guard: ({ context }) => context.skipping,
                target: '#icecastStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              {
                target: '#icecastStreaming.stopped',
                actions: [
                  ({ event }) => debugError(`streamSongAudio: ${actorErrorMessage(event)}`),
                  sendParent({ type: 'STREAM_ERROR', reason: 'streamSongAudio failed' }),
                ],
              },
            ],
          },
        },
      },
      on: {
        // Drain-before-transition: abort + flag, no state change. Onward
        // transition happens from the in-flight invoke's onDone/onError.
        SKIP_SONG: {
          actions: [({ context }) => context.abortController?.abort(), assign({ skipping: true })],
        },
      },
    },
    playingOutro: {
      invoke: {
        id: 'streamOutro',
        src: 'streamOutro',
        input: ({ context }) => context,
        onDone: {
          target: 'stopped',
          actions: sendParent({ type: 'STREAM_OUTRO_DONE' }),
        },
        onError: {
          target: 'stopped',
          actions: [
            ({ event }) => debugError(`streamOutro: ${actorErrorMessage(event)}`),
            sendParent({ type: 'STREAM_ERROR', reason: 'streamOutro failed' }),
          ],
        },
      },
    },
    stopped: {
      type: 'final',
      // Final states reject further transitions, but be explicit so a
      // second STOP can't try to re-enter via the top-level `on` handler.
      on: { STOP: {} },
      entry: 'cleanup',
    },
  },
});
