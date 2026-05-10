/**
 * Mux streaming child machine. Owns the Mux livestream lifecycle, the SRT
 * caller connection, and the MPEG-TS packet rewriter that keeps PCR/PTS/CC
 * monotonic across "file" boundaries. Speaks the same parent protocol as
 * `icecastMachine` (./types.ts).
 *
 * Lifecycle:
 *   idle              – await CONNECT
 *   creatingLivestream – Mux API call to provision a fresh audio-only stream
 *   connectingSrt     – open AsyncSRT caller, set sock opts, IPv4 lookup,
 *                       connect to global-live.mux.com:6001
 *   ready             – emits READY with player URL; awaits PLAY_*
 *   playingIntro      – stream audio/intro01.ts via the packet rewriter
 *   playingSong       – announcer (.ts) → emit SONG_STARTED → song (.ts)
 *   playingOutro      – stream the outro announcer .ts
 *   holding           – keep the SRT connection open ~30s past the last
 *                       packet so trailing HLS segments fully publish
 *   stopping          – close SRT, dispose AsyncSRT, delete Mux livestream
 *                       + recorded asset(s)
 *   stopped           – final
 *
 * Most of the wire-level code (AsyncSRT setup, packet rewriter, sender-side
 * pacing, IPv4 workaround for @eyevinn/srt's broken inet_pton) is ported
 * from src/srt-spike.ts (commit b1fc369).
 */

import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import Mux from '@mux/mux-node';
import { AsyncSRT } from '@eyevinn/srt';
import { setup, assign, fromPromise, sendParent } from 'xstate';

import { announcerFinal, transcodeFinal } from '../../utils/symbols.js';
import { fetchEnv } from '../../utils/fetch-env.js';
import { logger, debugError } from '../logger.js';
import type { Song } from '../song.js';
import { processPacket, TS_PACKET_SIZE, TS_SYNC_BYTE, type PacketContext } from './mpegts.js';
import type { ExtraAnnouncer, StreamingInput, StreamingInputEvent } from './types.js';

// ── Constants ───────────────────────────────────────────────────────────────

// `@eyevinn/srt`'s .d.ts omits AsyncSRT#dispose() but the method exists at
// runtime (it terminates the worker thread the binding spawns). Without it,
// the process hangs.
type AsyncSRTWithDispose = AsyncSRT & { dispose(): Promise<number> };

// SRTO_* values from libsrt's srt.h (see node_modules/@eyevinn/srt/src/srt-api-enums.ts).
const SRTO_LATENCY = 23;
const SRTO_PASSPHRASE = 26;
const SRTO_PBKEYLEN = 27;
const SRTO_CONNTIMEO = 36;
const SRTO_STREAMID = 46;
const SRTO_TRANSTYPE = 50;
const SRTT_LIVE = 0;
const SRT_ERROR = -1;

const MUX_SRT_HOST = 'global-live.mux.com';
const MUX_SRT_PORT = 6001;
const MUX_SRT_LATENCY_MS = 1000;
const MUX_SRT_CONN_TIMEOUT_MS = 8000;

// 7 × 188-byte TS packets = 1316 bytes, which is the SRT MSS in LIVE mode
// (1500 MTU − 184 UDP+IP+SRT overhead).
const TS_PACKETS_PER_SRT_CHUNK = 7;
const SRT_CHUNK_SIZE = TS_PACKETS_PER_SRT_CHUNK * TS_PACKET_SIZE;

// Sender-side pacing: never let the writer get more than this far ahead of
// real-time. Pacing reads PTS/PCR from each packet directly.
const PACING_LEAD_SEC = 15;
// After the outro we hold the SRT connection open this long so trailing-edge
// HLS segments fully publish to Mux before we tear down.
const TAIL_HOLD_SEC = 30;

const PLAYER_POSTER_URL = 'https://misc-cdn.thasauce.io/chorus/chorus-mux-poster.webp';

const INTRO_PATH = './audio/intro01.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function actorErrorMessage(event: unknown): string {
  const err = (event as { error?: unknown }).error;
  return (err as { message?: string })?.message ?? String(err);
}

function playerUrl(playbackId: string): string {
  return `https://player.mux.com/${playbackId}?poster=${encodeURIComponent(PLAYER_POSTER_URL)}`;
}

interface MuxLiveStream {
  id: string;
  streamKey: string;
  srtPassphrase: string;
  playbackId: string;
}

async function createMuxLiveStream(roundFullId: string): Promise<{
  client: Mux;
  liveStream: MuxLiveStream;
}> {
  const client = new Mux({
    tokenId: fetchEnv('MUX_TOKEN_ID'),
    tokenSecret: fetchEnv('MUX_TOKEN_SECRET'),
  });

  const created = await client.video.liveStreams.create({
    playback_policies: ['public'],
    audio_only: true,
    latency_mode: 'low',
    passthrough: roundFullId,
  });

  const playbackId = created.playback_ids?.[0]?.id;
  if (!created.stream_key || !created.srt_passphrase || !playbackId) {
    throw new Error(
      `Mux live stream response missing fields: ${JSON.stringify({
        hasStreamKey: !!created.stream_key,
        hasSrtPassphrase: !!created.srt_passphrase,
        hasPlaybackId: !!playbackId,
      })}`,
    );
  }

  return {
    client,
    liveStream: {
      id: created.id,
      streamKey: created.stream_key,
      srtPassphrase: created.srt_passphrase,
      playbackId,
    },
  };
}

interface SrtControl {
  asyncSrt: AsyncSRTWithDispose;
  socket: number;
  /** Sticky-error reader; first libsrt error wins. */
  getError: () => Error | null;
}

async function openSrtCaller(creds: MuxLiveStream): Promise<SrtControl> {
  const asyncSrt = new AsyncSRT() as AsyncSRTWithDispose;

  // The worker thread emits 'error' on libsrt errors. Without a listener,
  // Node throws ERR_UNHANDLED_ERROR. Record the first error in a sticky
  // variable so subsequent SRT calls can short-circuit instead of hanging
  // (@eyevinn/srt has a bug where post-error calls have their callbacks
  // shifted off the queue without being invoked).
  let stickyError: Error | null = null;
  asyncSrt.on('error', (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    stickyError ??= e;
    debugError(`[mux/srt] async error: ${e.message}`);
  });

  const socket = await asyncSrt.createSocket(true);

  await asyncSrt.setSockOpt(socket, SRTO_TRANSTYPE, SRTT_LIVE);
  await asyncSrt.setSockOpt(socket, SRTO_CONNTIMEO, MUX_SRT_CONN_TIMEOUT_MS);
  await asyncSrt.setSockOpt(socket, SRTO_STREAMID, creds.streamKey);
  await asyncSrt.setSockOpt(socket, SRTO_PASSPHRASE, creds.srtPassphrase);
  await asyncSrt.setSockOpt(socket, SRTO_PBKEYLEN, 16);
  await asyncSrt.setSockOpt(socket, SRTO_LATENCY, MUX_SRT_LATENCY_MS);

  // @eyevinn/srt's native binding uses inet_pton(AF_INET, host, ...) which
  // only parses IPv4 literals — it does NOT do DNS resolution. Resolve in JS.
  const { address: ipv4 } = await lookup(MUX_SRT_HOST, { family: 4 });
  logger.info({ host: MUX_SRT_HOST, ipv4 }, 'Mux SRT: resolved host, connecting');

  // Race connect against an explicit timeout because @eyevinn/srt orphans the
  // callback when libsrt errors during connect.
  const connectPromise = asyncSrt.connect(socket, ipv4, MUX_SRT_PORT);
  const timeoutPromise = new Promise<number>((_, reject) => {
    setTimeout(
      () => reject(new Error('connect promise hung (libsrt error swallowed by @eyevinn/srt)')),
      MUX_SRT_CONN_TIMEOUT_MS + 2000,
    );
  });

  let result: number;
  try {
    result = await Promise.race([connectPromise, timeoutPromise]);
  } catch (err) {
    await asyncSrt.close(socket).catch(() => {});
    await asyncSrt.dispose();
    throw err;
  }
  if (result === SRT_ERROR) {
    await asyncSrt.close(socket).catch(() => {});
    await asyncSrt.dispose();
    throw new Error(`SRT connect failed (result=${result})`);
  }

  return { asyncSrt, socket, getError: () => stickyError };
}

async function closeSrtCaller(control: SrtControl | null): Promise<void> {
  if (!control) return;
  // close() may hang if AsyncSRT's internal callback queue got desynced from
  // an error mid-stream. Race with a short timeout so we always reach
  // dispose(), which terminates the worker thread directly.
  await Promise.race([
    control.asyncSrt.close(control.socket).catch((err: unknown) => {
      debugError(`[mux/srt] close error: ${err instanceof Error ? err.message : String(err)}`);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  await control.asyncSrt.dispose();
}

async function deleteMuxLiveStream(client: Mux, liveStreamId: string): Promise<void> {
  // Mux's ingest takes a few seconds after stream end to finalize the asset
  // and populate recent_asset_ids. Wait briefly so we can find them.
  await sleep(3000);

  let assetIds: string[] = [];
  try {
    const ls = await client.video.liveStreams.retrieve(liveStreamId);
    assetIds = ls.recent_asset_ids ?? [];
  } catch (err) {
    debugError(
      `[mux] retrieve for cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const assetId of assetIds) {
    try {
      await client.video.assets.delete(assetId);
    } catch (err) {
      debugError(
        `[mux] failed to delete asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    await client.video.liveStreams.delete(liveStreamId);
  } catch (err) {
    debugError(
      `[mux] failed to delete live stream ${liveStreamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  logger.info(
    { liveStreamId, deletedAssets: assetIds.length },
    'Mux: cleaned up livestream + assets',
  );
}

interface PacingState {
  /** performance.now() ms at the first SRT write; null until then. */
  startMs: number | null;
}

/**
 * Stream one MPEG-TS file: read 188-byte packets, rewrite CC/PCR/PTS/DTS via
 * `processPacket`, send to SRT in 1316-byte chunks, throttle so the latest
 * stream-time stays within `PACING_LEAD_SEC` of wall-clock. Aborts early if
 * `signal` fires (skip-song).
 */
async function streamPacketFile({
  control,
  filePath,
  offsetSec,
  ctx,
  pacing,
  signal,
}: {
  control: SrtControl;
  filePath: string;
  offsetSec: number;
  ctx: PacketContext;
  pacing: PacingState;
  signal: AbortSignal;
}): Promise<{ packetsSent: number; lastStreamTimeSec: number }> {
  const offset90kHz = BigInt(Math.round(offsetSec * 90_000));
  // Seed the PacketContext for this file so file-boundary writes (before the
  // first PCR/PTS arrives) aren't gated against a stale value from the prior
  // file.
  if (ctx.latestStreamTimeSec < offsetSec) ctx.latestStreamTimeSec = offsetSec;

  const { asyncSrt, socket, getError } = control;

  async function srtWrite(chunk: Buffer): Promise<number> {
    const prior = getError();
    if (prior) throw prior;
    let listener: ((err: unknown) => void) | undefined;
    const errorRace = new Promise<never>((_, reject) => {
      listener = (err) => reject(err instanceof Error ? err : new Error(String(err)));
      asyncSrt.once('error', listener);
    });
    try {
      return await Promise.race([asyncSrt.write(socket, chunk), errorRace]);
    } finally {
      if (listener) asyncSrt.off('error', listener);
    }
  }

  async function paceBeforeWrite(): Promise<void> {
    if (pacing.startMs === null) {
      pacing.startMs = performance.now();
      return;
    }
    const elapsedSec = (performance.now() - pacing.startMs) / 1000;
    const lead = ctx.latestStreamTimeSec - elapsedSec;
    if (lead > PACING_LEAD_SEC) await sleep((lead - PACING_LEAD_SEC) * 1000);
  }

  const fileHandle = await fs.promises.open(filePath, 'r');
  const chunkBuf = Buffer.alloc(SRT_CHUNK_SIZE);
  let packetsInChunk = 0;
  let packetsSent = 0;

  try {
    while (!signal.aborted) {
      const off = packetsInChunk * TS_PACKET_SIZE;
      const { bytesRead } = await fileHandle.read(chunkBuf, off, TS_PACKET_SIZE, null);
      if (bytesRead === 0) break;
      if (bytesRead !== TS_PACKET_SIZE) {
        logger.warn(
          { filePath, bytesRead },
          '[mux/srt] short TS packet at end of file; ignoring tail',
        );
        break;
      }

      const packet = chunkBuf.subarray(off, off + TS_PACKET_SIZE);
      if (packet[0] !== TS_SYNC_BYTE) {
        throw new Error(`MPEG-TS sync byte missing at packet ${packetsInChunk} of ${filePath}`);
      }
      processPacket(packet, offset90kHz, ctx);
      packetsInChunk++;
      packetsSent++;

      if (packetsInChunk === TS_PACKETS_PER_SRT_CHUNK) {
        await paceBeforeWrite();
        // Each SRT write needs a Buffer whose underlying ArrayBuffer is
        // standalone (not Node's shared Buffer pool) — @eyevinn/srt
        // postMessages chunk.buffer in its transferList and pool-backed
        // buffers can't be transferred. allocUnsafeSlow bypasses the pool.
        const out = Buffer.allocUnsafeSlow(SRT_CHUNK_SIZE);
        chunkBuf.copy(out);
        const result = await srtWrite(out);
        if (result === SRT_ERROR) {
          throw new Error(`SRT write returned SRT_ERROR after ${packetsSent} packets`);
        }
        packetsInChunk = 0;
      }
    }
    if (!signal.aborted && packetsInChunk > 0) {
      await paceBeforeWrite();
      const flushSize = packetsInChunk * TS_PACKET_SIZE;
      const out = Buffer.allocUnsafeSlow(flushSize);
      chunkBuf.copy(out, 0, 0, flushSize);
      const result = await srtWrite(out);
      if (result === SRT_ERROR) {
        throw new Error(`SRT write returned SRT_ERROR on flush after ${packetsSent} packets`);
      }
    }
  } finally {
    await fileHandle.close();
  }

  return { packetsSent, lastStreamTimeSec: ctx.latestStreamTimeSec };
}

// ── Machine ────────────────────────────────────────────────────────────────

interface MuxContext {
  round: { fullId: string };
  client: Mux | null;
  liveStream: MuxLiveStream | null;
  srtControl: SrtControl | null;
  packetCtx: PacketContext;
  pacing: PacingState;
  abortController: AbortController | null;
  currentSong: Song | null;
  outroAnnouncer: ExtraAnnouncer | null;
}

type MuxInternalEvent =
  | { type: 'LIVESTREAM_READY'; client: Mux; liveStream: MuxLiveStream }
  | { type: 'SRT_CONNECTED'; control: SrtControl };

type MuxEvent = StreamingInputEvent | MuxInternalEvent;

export const muxMachine = setup({
  types: {
    input: {} as StreamingInput,
    context: {} as MuxContext,
    events: {} as MuxEvent,
  },
  actors: {
    createLivestream: fromPromise<
      { client: Mux; liveStream: MuxLiveStream },
      { round: { fullId: string } }
    >(({ input }) => createMuxLiveStream(input.round.fullId)),
    connectSrt: fromPromise<SrtControl, { liveStream: MuxLiveStream }>(({ input }) =>
      openSrtCaller(input.liveStream),
    ),
    streamFile: fromPromise<
      { lastStreamTimeSec: number },
      {
        control: SrtControl;
        filePath: string;
        ctx: PacketContext;
        pacing: PacingState;
        abortController: AbortController;
      }
    >(({ input }) =>
      streamPacketFile({
        control: input.control,
        filePath: input.filePath,
        offsetSec: input.ctx.latestStreamTimeSec,
        ctx: input.ctx,
        pacing: input.pacing,
        signal: input.abortController.signal,
      }),
    ),
    tailHold: fromPromise<void, void>(async () => {
      await sleep(TAIL_HOLD_SEC * 1000);
    }),
    teardown: fromPromise<void, MuxContext>(async ({ input }) => {
      if (input.abortController) input.abortController.abort();
      await closeSrtCaller(input.srtControl);
      if (input.client && input.liveStream) {
        await deleteMuxLiveStream(input.client, input.liveStream.id);
      }
    }),
  },
}).createMachine({
  id: 'muxStreaming',
  initial: 'idle',
  context: ({ input }) => ({
    round: input.round,
    client: null,
    liveStream: null,
    srtControl: null,
    packetCtx: { ccByPid: new Map(), latestStreamTimeSec: 0 },
    pacing: { startMs: null },
    abortController: null,
    currentSong: null,
    outroAnnouncer: null,
  }),
  on: {
    STOP: { target: '.stopping' },
  },
  states: {
    idle: {
      on: { CONNECT: 'creatingLivestream' },
    },
    creatingLivestream: {
      invoke: {
        src: 'createLivestream',
        input: ({ context }) => ({ round: context.round }),
        onDone: {
          target: 'connectingSrt',
          actions: assign(({ event }) => ({
            client: event.output.client,
            liveStream: event.output.liveStream,
          })),
        },
        onError: {
          target: 'stopping',
          actions: [
            ({ event }) => debugError(`Mux livestream create failed: ${actorErrorMessage(event)}`),
            sendParent({ type: 'STREAM_ERROR', reason: 'Mux livestream create failed' }),
          ],
        },
      },
    },
    connectingSrt: {
      invoke: {
        src: 'connectSrt',
        input: ({ context }) => ({ liveStream: context.liveStream! }),
        onDone: {
          target: 'ready',
          actions: [
            assign(({ event }) => ({ srtControl: event.output })),
            sendParent(({ context }) => ({
              type: 'STREAM_READY',
              url: playerUrl(context.liveStream!.playbackId),
            })),
          ],
        },
        onError: {
          target: 'stopping',
          actions: [
            ({ event }) => debugError(`SRT connect failed: ${actorErrorMessage(event)}`),
            sendParent({ type: 'STREAM_ERROR', reason: 'SRT connect failed' }),
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
        src: 'streamFile',
        input: ({ context }) => ({
          control: context.srtControl!,
          filePath: INTRO_PATH,
          ctx: context.packetCtx,
          pacing: context.pacing,
          abortController: context.abortController!,
        }),
        onDone: {
          target: 'ready',
          actions: sendParent({ type: 'STREAM_INTRO_DONE' }),
        },
        onError: {
          target: 'stopping',
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
      initial: 'announcer',
      states: {
        announcer: {
          invoke: {
            src: 'streamFile',
            input: ({ context }) => ({
              control: context.srtControl!,
              filePath: context.currentSong!.path(announcerFinal),
              ctx: context.packetCtx,
              pacing: context.pacing,
              abortController: context.abortController!,
            }),
            onDone: 'songAudio',
            onError: {
              target: '#muxStreaming.stopping',
              actions: [
                ({ event }) => debugError(`streamAnnouncer: ${actorErrorMessage(event)}`),
                sendParent({ type: 'STREAM_ERROR', reason: 'streamAnnouncer failed' }),
              ],
            },
          },
        },
        songAudio: {
          entry: sendParent({ type: 'STREAM_SONG_STARTED' }),
          invoke: {
            src: 'streamFile',
            input: ({ context }) => ({
              control: context.srtControl!,
              filePath: context.currentSong!.path(transcodeFinal),
              ctx: context.packetCtx,
              pacing: context.pacing,
              abortController: context.abortController!,
            }),
            onDone: {
              target: '#muxStreaming.ready',
              actions: sendParent({ type: 'STREAM_SONG_DONE' }),
            },
            onError: {
              target: '#muxStreaming.stopping',
              actions: [
                ({ event }) => debugError(`streamSongAudio: ${actorErrorMessage(event)}`),
                sendParent({ type: 'STREAM_ERROR', reason: 'streamSongAudio failed' }),
              ],
            },
          },
        },
      },
      on: {
        SKIP_SONG: {
          target: 'ready',
          actions: [
            ({ context }) => context.abortController?.abort(),
            sendParent({ type: 'STREAM_SONG_DONE' }),
          ],
        },
      },
    },
    playingOutro: {
      invoke: {
        src: 'streamFile',
        input: ({ context }) => ({
          control: context.srtControl!,
          filePath: context.outroAnnouncer!.path,
          ctx: context.packetCtx,
          pacing: context.pacing,
          abortController: context.abortController!,
        }),
        onDone: {
          target: 'holding',
          // OUTRO_DONE is emitted from `holding` once the tail-hold elapses,
          // not here — listeners are still hearing audio thanks to Mux's HLS
          // buffer, and we want the parent's notion of "outro done" to mean
          // "listeners have heard the outro," matching Icecast's semantics.
        },
        onError: {
          target: 'stopping',
          actions: [
            ({ event }) => debugError(`streamOutro: ${actorErrorMessage(event)}`),
            sendParent({ type: 'STREAM_ERROR', reason: 'streamOutro failed' }),
          ],
        },
      },
    },
    holding: {
      invoke: {
        src: 'tailHold',
        onDone: {
          target: 'stopping',
          actions: sendParent({ type: 'STREAM_OUTRO_DONE' }),
        },
      },
    },
    stopping: {
      invoke: {
        src: 'teardown',
        input: ({ context }) => context,
        onDone: 'stopped',
        onError: {
          target: 'stopped',
          actions: ({ event }) => debugError(`Mux teardown error: ${actorErrorMessage(event)}`),
        },
      },
    },
    stopped: { type: 'final' },
  },
});
