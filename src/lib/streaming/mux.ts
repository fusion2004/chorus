/**
 * Mux streaming child machine. Owns the Mux livestream lifecycle, the SRT
 * caller connection, and the MPEG-TS packet rewriter that keeps PCR/PTS/CC
 * monotonic across "file" boundaries. Speaks the same parent protocol as
 * `icecastMachine` (./types.ts).
 *
 * Lifecycle:
 *   idle              – await CONNECT
 *   creatingLivestream – sweep leftover chorus-* entries, then create a fresh
 *                       audio-only livestream tagged `meta.title = chorus-<ulid>`
 *   connectingSrt     – open AsyncSRT caller, set sock opts, IPv4 lookup,
 *                       connect to global-live.mux.com:6001
 *   ready             – emits READY with player URL; awaits PLAY_*
 *   playingIntro      – stream audio/intro01.ts via the packet rewriter
 *   playingSong       – announcer (.ts) → emit SONG_STARTED → song (.ts)
 *   playingOutro      – stream the outro announcer .ts
 *   holding           – keep the SRT connection open ~30s past the last
 *                       packet so trailing HLS segments fully publish
 *   stopping          – close SRT, dispose AsyncSRT. We deliberately do NOT
 *                       delete the Mux livestream / asset here — that cuts
 *                       trailing HLS playback for any listener still
 *                       streaming the wind-down. Cleanup happens at the
 *                       start of the *next* party via cleanupChorusLeftovers().
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
import { ulid } from 'ulid';

import { announcerFinal, transcodeFinal } from '../../utils/symbols.js';
import { fetchEnv } from '../../utils/fetch-env.js';
import { logger, debugError, debugInfo, debugWarn } from '../logger.js';
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
// Mux holds the livestream open this long after a disconnect, accepting a
// reconnect with the same stream key. Must comfortably exceed the time it
// takes us to tear down a broken socket and reconnect (DNS + handshake +
// retry, typically a few seconds).
const MUX_RECONNECT_WINDOW_SEC = 30;
// Interval for srt_bstats polling — frequent enough that the snapshot before
// a disconnect is useful, sparse enough not to spam logs.
const SRT_STATS_INTERVAL_MS = 2000;
// Maximum SRT reconnect attempts per streamFile invocation (per intro /
// announcer / song / outro). Multiple-disconnect scenarios in production
// have shown one retry isn't always enough; cap stops a fully-broken path
// from looping forever.
const MAX_RECONNECTS_PER_FILE = 5;

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

/** Title prefix that identifies a chorus-managed Mux entity. */
const CHORUS_TITLE_PREFIX = 'chorus-';

async function createMuxLiveStream(roundFullId: string): Promise<{
  client: Mux;
  liveStream: MuxLiveStream;
}> {
  const client = new Mux({
    tokenId: fetchEnv('MUX_TOKEN_ID'),
    tokenSecret: fetchEnv('MUX_TOKEN_SECRET'),
  });

  // Sweep leftover chorus-* entries from prior parties first. We deliberately
  // don't tear those down at end-of-stream because that cuts trailing HLS
  // segments off mid-listener; cleaning up on the next start instead lets
  // each stream live out its natural HLS playback tail.
  await cleanupChorusLeftovers(client);

  const title = `${CHORUS_TITLE_PREFIX}${ulid()}`;
  const created = await client.video.liveStreams.create({
    playback_policies: ['public'],
    audio_only: true,
    latency_mode: 'low',
    // Low Latency defaults reconnect_window to 0, which rejects any reconnect
    // attempt. We need a non-zero window so a transient SRT drop (handled by
    // the reconnect path in streamPacketFile) lands on the same livestream
    // instead of being treated as an end-of-stream.
    reconnect_window: MUX_RECONNECT_WINDOW_SEC,
    passthrough: roundFullId,
    meta: { title },
    new_asset_settings: { meta: { title } },
  });
  logger.info({ liveStreamId: created.id, title }, '[mux] created livestream');

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

/**
 * List every Mux livestream and asset in the account, deleting any whose
 * `meta.title` starts with the chorus prefix. Called at the start of each
 * Mux-backed party — see the comment on createMuxLiveStream for the
 * "sweep-on-start, not teardown-on-stop" rationale.
 */
async function cleanupChorusLeftovers(client: Mux): Promise<void> {
  let deletedStreams = 0;
  let deletedAssets = 0;

  try {
    for await (const ls of client.video.liveStreams.list()) {
      const title = ls.meta?.title;
      if (!title?.startsWith(CHORUS_TITLE_PREFIX)) continue;
      try {
        await client.video.liveStreams.delete(ls.id);
        deletedStreams++;
        logger.info({ liveStreamId: ls.id, title }, '[mux/cleanup] deleted leftover livestream');
      } catch (err) {
        debugError(
          `[mux/cleanup] failed to delete livestream ${ls.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    debugError(
      `[mux/cleanup] livestream list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    for await (const asset of client.video.assets.list()) {
      const title = asset.meta?.title;
      if (!title?.startsWith(CHORUS_TITLE_PREFIX)) continue;
      try {
        await client.video.assets.delete(asset.id);
        deletedAssets++;
        logger.info({ assetId: asset.id, title }, '[mux/cleanup] deleted leftover asset');
      } catch (err) {
        debugError(
          `[mux/cleanup] failed to delete asset ${asset.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    debugError(
      `[mux/cleanup] asset list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logger.info({ deletedStreams, deletedAssets }, '[mux/cleanup] swept previous chorus-* entries');
}

interface SrtControl {
  asyncSrt: AsyncSRTWithDispose;
  socket: number;
  /** Sticky-error reader; first libsrt error wins. */
  getError: () => Error | null;
  /** Stops the periodic srt_bstats poller attached at openSrtCaller. */
  stopStats: () => void;
}

/**
 * Periodically poll `srt_bstats` and log the headline counters. Without this
 * we have no ground truth on whether disconnects come from packet loss
 * (rising retrans/loss), receiver silence (RTT spiking, ACKs stalling), or
 * our own buffer pressure. Errors from `stats()` are swallowed because the
 * call can fail in transitional socket states; we don't want a logger
 * crashing the stream.
 */
function startStatsLogger(asyncSrt: AsyncSRTWithDispose, socket: number): () => void {
  let stopped = false;
  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      const s = await asyncSrt.stats(socket, true);
      if (stopped) return;
      logger.info(
        {
          socket,
          msRTT: s.msRTT,
          mbpsSendRate: s.mbpsSendRate,
          mbpsBandwidth: s.mbpsBandwidth,
          pktSent: s.pktSent,
          pktSndLoss: s.pktSndLoss,
          pktRetrans: s.pktRetrans,
          pktSndDrop: s.pktSndDrop,
          pktFlightSize: s.pktFlightSize,
          pktSndBuf: s.pktSndBuf,
          msSndBuf: s.msSndBuf,
        },
        '[mux/srt] stats',
      );
    } catch {
      // ignore — stats can fail in transitional socket states
    }
  }, SRT_STATS_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
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

  const stopStats = startStatsLogger(asyncSrt, socket);
  return { asyncSrt, socket, getError: () => stickyError, stopStats };
}

async function closeSrtCaller(control: SrtControl | null): Promise<void> {
  if (!control) return;
  control.stopStats();
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

function isConnectionBroken(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Connection was broken');
}

/**
 * Replace the broken SRT caller in-place. Mux's `reconnect_window` keeps the
 * livestream alive across the gap, so re-authenticating with the same
 * stream key resumes the same Mux ingest. We mutate the SrtControl object
 * (Object.assign) because machine context holds the same reference — after
 * this returns, subsequent fromPromise inputs see the new socket/asyncSrt
 * without an XState assign.
 */
async function reconnectSrt(control: SrtControl, liveStream: MuxLiveStream): Promise<void> {
  debugWarn('[mux/srt] connection broken; reconnecting');
  await closeSrtCaller(control).catch((err: unknown) => {
    debugError(
      `[mux/srt] error closing broken control: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const fresh = await openSrtCaller(liveStream);
  Object.assign(control, fresh);
  debugInfo({ socket: control.socket }, '[mux/srt] reconnected after broken connection');
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
  liveStream,
  filePath,
  offsetSec,
  ctx,
  pacing,
  signal,
}: {
  control: SrtControl;
  liveStream: MuxLiveStream;
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

  // Up to MAX_RECONNECTS_PER_FILE reconnect attempts per streamFile invocation.
  // Resets every call so a multi-song party can recover from drops on multiple
  // files; bounded per-call so a persistently bad path doesn't spin reconnects
  // forever.
  let reconnectsRemaining = MAX_RECONNECTS_PER_FILE;

  async function srtWrite(chunk: Buffer): Promise<number> {
    while (true) {
      // Re-read asyncSrt/socket each iteration so we use the fresh handle
      // after a reconnect (reconnectSrt mutates `control` in place).
      const ae = control.asyncSrt;
      const sock = control.socket;
      const prior = control.getError();
      if (prior) {
        if (isConnectionBroken(prior) && reconnectsRemaining > 0) {
          reconnectsRemaining--;
          await reconnectSrt(control, liveStream);
          continue;
        }
        throw prior;
      }
      let listener: ((err: unknown) => void) | undefined;
      const errorRace = new Promise<never>((_, reject) => {
        listener = (err) => reject(err instanceof Error ? err : new Error(String(err)));
        ae.once('error', listener);
      });
      try {
        return await Promise.race([ae.write(sock, chunk), errorRace]);
      } catch (err) {
        if (isConnectionBroken(err) && reconnectsRemaining > 0) {
          reconnectsRemaining--;
          // Remove the listener from the old (about-to-be-disposed) asyncSrt
          // before reconnecting — finally would do the same, but explicit
          // here keeps the order obvious.
          if (listener) ae.off('error', listener);
          listener = undefined;
          await reconnectSrt(control, liveStream);
          continue;
        }
        throw err;
      } finally {
        if (listener) ae.off('error', listener);
      }
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

  // PES-boundary-aware abort. Once `signal.aborted` is true we set
  // `drainingToBoundary`; the loop keeps reading + sending until it sees a
  // packet with PUSI=1 on the audio PES PID — i.e. the start of the *next*
  // PES, which means the one we were mid-way through is now fully on the
  // wire. Without this, /skipsong cuts mid-PES and Mux's HLS segmenter
  // stalls on the truncated audio frame, then drops the connection a few
  // seconds later.
  //
  // pesPid is detected from the first PUSI=1 packet whose payload begins
  // with the PES start-code prefix `0x00 0x00 0x01`. PSI tables (PAT/PMT)
  // also use PUSI=1 but their payloads start with a table_id byte, so they
  // don't get falsely identified. Until we've seen at least one PES packet
  // pesPid stays null and we'll stop at any PUSI=1 (safe fallback — we're
  // still in the PSI preamble before any audio has been sent).
  let drainingToBoundary = false;
  let pesPid: number | null = null;

  try {
    while (true) {
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

      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const pusi = (packet[1] & 0x40) !== 0;

      // PES-boundary stop check: PUSI=1 on the audio PID means a new PES is
      // starting, so the previous one (which abort caught us in the middle
      // of) is now complete on the wire. Stop *before* sending this packet.
      if (drainingToBoundary && pusi && (pesPid === null || pid === pesPid)) {
        break;
      }

      // First time we see a PES start, lock pesPid so subsequent PSI table
      // PUSI=1 packets don't trip the boundary check above.
      if (pesPid === null && pusi) {
        const afc = (packet[3] >> 4) & 0x03;
        const hasAF = (afc & 0x02) !== 0;
        const hasPayload = (afc & 0x01) !== 0;
        const payloadStart = hasAF ? 5 + packet[4] : 4;
        if (
          hasPayload &&
          payloadStart + 2 < TS_PACKET_SIZE &&
          packet[payloadStart] === 0x00 &&
          packet[payloadStart + 1] === 0x00 &&
          packet[payloadStart + 2] === 0x01
        ) {
          pesPid = pid;
        }
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

      // Set the draining flag *after* sending this packet so we don't bail
      // out on the very first PUSI=1 — that's the start of the first PES of
      // the file, which we obviously want to send.
      if (signal.aborted) drainingToBoundary = true;
    }

    // Always flush remaining buffered packets — even on abort, those are
    // part of the in-flight PES we just committed to finishing.
    if (packetsInChunk > 0) {
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
  /**
   * Set true by SKIP_SONG. Drain-before-transition: we let the in-flight
   * streamFile promise resolve naturally (after its abort-aware loop exits),
   * then announcer.onDone branches on this flag to skip songAudio entirely.
   * Without it, transitioning out of playingSong while a streamFile is still
   * in mid-write would let the next song's streamFile race onto the same
   * AsyncSRT socket — Mux sees interleaved packets and drops the connection.
   * Reset to false on each entry to playingSong.
   */
  skipping: boolean;
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
        liveStream: MuxLiveStream;
        filePath: string;
        ctx: PacketContext;
        pacing: PacingState;
        abortController: AbortController;
      }
    >(({ input }) =>
      streamPacketFile({
        control: input.control,
        liveStream: input.liveStream,
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
      // We deliberately don't delete the livestream or asset here — doing so
      // truncates trailing HLS segments for listeners still hearing the
      // wind-down. Cleanup happens at the start of the *next* party via
      // cleanupChorusLeftovers().
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
    skipping: false,
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
          liveStream: context.liveStream!,
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
      // Reset skipping on entry — each new song starts fresh. The in-flight
      // streamFile from a prior song should have already drained by now.
      entry: assign({ skipping: false }),
      initial: 'announcer',
      states: {
        announcer: {
          invoke: {
            src: 'streamFile',
            input: ({ context }) => ({
              control: context.srtControl!,
              liveStream: context.liveStream!,
              filePath: context.currentSong!.path(announcerFinal),
              ctx: context.packetCtx,
              pacing: context.pacing,
              abortController: context.abortController!,
            }),
            onDone: [
              {
                guard: ({ context }) => context.skipping,
                target: '#muxStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              { target: 'songAudio' },
            ],
            onError: [
              // If we were skipping, suppress the error — a write that failed
              // mid-abort is expected (e.g. SRT half-flushed packet group).
              // Just emit SONG_DONE and move on.
              {
                guard: ({ context }) => context.skipping,
                target: '#muxStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              {
                target: '#muxStreaming.stopping',
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
            src: 'streamFile',
            input: ({ context }) => ({
              control: context.srtControl!,
              liveStream: context.liveStream!,
              filePath: context.currentSong!.path(transcodeFinal),
              ctx: context.packetCtx,
              pacing: context.pacing,
              abortController: context.abortController!,
            }),
            onDone: {
              target: '#muxStreaming.ready',
              actions: sendParent({ type: 'STREAM_SONG_DONE' }),
            },
            onError: [
              // Same skipping suppression as announcer.
              {
                guard: ({ context }) => context.skipping,
                target: '#muxStreaming.ready',
                actions: sendParent({ type: 'STREAM_SONG_DONE' }),
              },
              {
                target: '#muxStreaming.stopping',
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
        // Drain-before-transition: don't change state. Just abort the in-flight
        // streamFile loop and set the skipping flag. The current invoke's
        // onDone (or onError) sees skipping=true and routes to ready + emits
        // STREAM_SONG_DONE. Prevents a second streamFile from racing onto the
        // SRT socket while the first is still mid-write.
        SKIP_SONG: {
          actions: [({ context }) => context.abortController?.abort(), assign({ skipping: true })],
        },
      },
    },
    playingOutro: {
      invoke: {
        src: 'streamFile',
        input: ({ context }) => ({
          control: context.srtControl!,
          liveStream: context.liveStream!,
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
      // Ignore additional STOP events while we're already tearing down.
      // Without this, the top-level `on: { STOP: { target: '.stopping' } }`
      // re-enters this state on the second STOP (which the parent fires from
      // partying.exit when STREAM_ERROR escalates), invoking teardown twice
      // and crashing on the double `asyncSrt.dispose()` call.
      on: { STOP: {} },
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
    stopped: {
      type: 'final',
      // Final states are already sealed against further transitions, but be
      // explicit so a stray STOP doesn't try to re-enter via the top-level on.
      on: { STOP: {} },
    },
  },
});
