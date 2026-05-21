/*
 * SRT → Mux audio-only streaming spike. Standalone, not bot-integrated.
 *
 * Required env (export in shell, do not commit):
 *   MUX_TOKEN_ID       — Mux API access token ID
 *   MUX_TOKEN_SECRET   — Mux API access token secret
 * System prereq: brew install srt   (libsrt for @eyevinn/srt)
 * Run:           yarn spike:srt
 *
 * What it does:
 *   1. Creates an audio-only Mux livestream via @mux/mux-node.
 *   2. Pre-transcodes the 3 MP3s in audio/ to AAC-in-MPEG-TS at audio/ts/*.ts
 *      using ffmpeg-static + the built-in `aac` encoder.
 *   3. Opens an SRT caller connection to global-live.mux.com:6001.
 *   4. Streams the .ts files directly from disk, parsing and rewriting MPEG-TS
 *      packets in-flight. No phase-2 ffmpeg. For each 188-byte packet we:
 *        - rewrite the continuity counter using a single per-PID running
 *          counter that crosses file boundaries, so Mux sees no CC reset;
 *        - shift the PCR (33-bit base in adaptation field) by a cumulative
 *          90 kHz offset, so PCR is monotonic across files;
 *        - shift PTS/DTS in PES headers by the same offset.
 *      Packets are written to SRT in 7-packet (1316-byte) chunks.
 *      Pacing reads PTS/PCR from each packet directly and sleeps when the
 *      most-recent timestamp gets more than PACING_LEAD_SEC ahead of
 *      wall-clock — exact, no estimation, no progress polling.
 *   5. Cleans up the Mux livestream + any auto-created assets in finally.
 *      Plan: ~/.claude/plans/we-should-experiment-with-frolicking-blanket.md
 */

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Mux from '@mux/mux-node';
import { AsyncSRT, setSRTLoggingLevel } from '@eyevinn/srt';
import { parseFile } from 'music-metadata';

// @eyevinn/srt's .d.ts omits AsyncSRT#dispose() but the method exists at runtime
// (it terminates the worker thread the binding spawns). Without it, the process hangs.
type AsyncSRTWithDispose = AsyncSRT & { dispose(): Promise<number> };

// ffmpeg-static is CJS and `module.exports` IS the path string, but its .d.ts
// uses `export default` which TS 6 + NodeNext can't reconcile against the
// runtime shape. createRequire sidesteps the type mismatch.
const cjsRequire = createRequire(import.meta.url);
const ffmpegPath = cjsRequire('ffmpeg-static') as string | null;
if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
const FFMPEG_BIN: string = ffmpegPath;

// SRTO_* values from libsrt's srt.h (also at node_modules/@eyevinn/srt/src/srt-api-enums.ts).
// Pulled inline so we don't need to import .ts source from a JS package.
const SRTO_LATENCY = 23;
const SRTO_PASSPHRASE = 26;
const SRTO_PBKEYLEN = 27;
const SRTO_CONNTIMEO = 36;
const SRTO_STREAMID = 46;
const SRTO_TRANSTYPE = 50;

// SRT transmission types.
const SRTT_LIVE = 0;

const SRT_ERROR = -1;

// SRTSockStatus enum → readable names (from @eyevinn/srt/src/srt-api-enums.ts).
const SOCK_STATE_NAMES: Record<number, string> = {
  1: 'INIT',
  2: 'OPENED',
  3: 'LISTENING',
  4: 'CONNECTING',
  5: 'CONNECTED',
  6: 'BROKEN',
  7: 'CLOSING',
  8: 'CLOSED',
  9: 'NONEXIST',
};

// Mux SRT ingest endpoint.
const MUX_SRT_HOST = 'global-live.mux.com';
const MUX_SRT_PORT = 6001;
const MUX_SRT_LATENCY_MS = 1000;
const MUX_SRT_CONN_TIMEOUT_MS = 8000; // libsrt default is 3000; bump in case Mux's handshake is slow.

// Stream a single source file repeated N times, so we exercise the packet
// rewriter (continuity counter, PCR/PTS offset) across many "file" boundaries
// without having to compare across files of differing content.
const SOURCE_BASENAME = 'intro01';
const STREAM_REPEATS = 6;
const AUDIO_DIR = path.join(process.cwd(), 'audio');
const TS_DIR = path.join(AUDIO_DIR, 'ts');

// MPEG-TS packet layout: a fixed 188-byte packet starting with sync byte 0x47.
const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
// PTS, DTS, and PCR base are all expressed in 90 kHz ticks.
const PTS_HZ = 90_000;
// We pack 7 TS packets into each SRT write — 7 * 188 = 1316 bytes, which is
// the SRT MSS in LIVE mode (1500 MTU - 184 UDP+IP+SRT overhead).
const TS_PACKETS_PER_SRT_CHUNK = 7;
const SRT_CHUNK_SIZE = TS_PACKETS_PER_SRT_CHUNK * TS_PACKET_SIZE;

// Sender-side pacing: never let the SRT writer get more than this far ahead of
// real-time. Pacing now reads PTS/PCR straight out of every packet we send,
// so the lead is measured against actual stream-time of bytes on the wire.
const PACING_LEAD_SEC = 15;
// After streaming, hold the SRT connection open for this long past the
// expected playback end so trailing-edge HLS segments fully publish to Mux.
const TAIL_HOLD_SEC = 30;

interface PacingState {
  // performance.now() ms at the first SRT write; null until then.
  startMs: number | null;
}

interface PacketContext {
  // Per-PID running continuity counter (4 bits). Maintained across files so
  // Mux never sees a CC reset at a file boundary.
  ccByPid: Map<number, number>;
  // Most recent PTS or PCR (in seconds, post-offset) we've embedded in a
  // packet handed off to SRT. Pacing reads this to decide when to sleep.
  latestStreamTimeSec: number;
}

interface LiveStreamCreds {
  id: string;
  streamKey: string;
  srtPassphrase: string;
  playbackId: string;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// ── MPEG-TS field accessors ──────────────────────────────────────────────────
//
// Timestamp encoding (PTS/DTS, 33 bits in 5 bytes — H.222.0 §2.4.3.6):
//   byte 0:  prefix(4) | TS[32:30](3) | marker(1)=1
//   byte 1:  TS[29:22]
//   byte 2:  TS[21:15] | marker(1)=1
//   byte 3:  TS[14:7]
//   byte 4:  TS[6:0]   | marker(1)=1
// `prefix` is 0010 for "PTS only", 0011 for "PTS in PTS+DTS", 0001 for "DTS".
//
// PCR encoding (33-bit base + 6 reserved + 9-bit extension = 6 bytes):
//   bytes 0-3:  base[32:1]
//   byte 4:     base[0] | reserved(6) | ext[8]
//   byte 5:     ext[7:0]

function readTimestamp33(buf: Buffer, off: number): bigint {
  return (
    (BigInt((buf[off] >> 1) & 0x07) << 30n) |
    (BigInt(buf[off + 1]) << 22n) |
    (BigInt((buf[off + 2] >> 1) & 0x7f) << 15n) |
    (BigInt(buf[off + 3]) << 7n) |
    BigInt((buf[off + 4] >> 1) & 0x7f)
  );
}

function writeTimestamp33(buf: Buffer, off: number, value: bigint, prefix: number): void {
  const v = value & 0x1ffffffffn;
  buf[off] = (prefix << 4) | (Number((v >> 30n) & 0x07n) << 1) | 0x01;
  buf[off + 1] = Number((v >> 22n) & 0xffn);
  buf[off + 2] = (Number((v >> 15n) & 0x7fn) << 1) | 0x01;
  buf[off + 3] = Number((v >> 7n) & 0xffn);
  buf[off + 4] = (Number(v & 0x7fn) << 1) | 0x01;
}

function readPCRBase(buf: Buffer, off: number): bigint {
  return (
    (BigInt(buf[off]) << 25n) |
    (BigInt(buf[off + 1]) << 17n) |
    (BigInt(buf[off + 2]) << 9n) |
    (BigInt(buf[off + 3]) << 1n) |
    BigInt(buf[off + 4] >> 7)
  );
}

function writePCRBase(buf: Buffer, off: number, base: bigint): void {
  const b = base & 0x1ffffffffn;
  buf[off] = Number((b >> 25n) & 0xffn);
  buf[off + 1] = Number((b >> 17n) & 0xffn);
  buf[off + 2] = Number((b >> 9n) & 0xffn);
  buf[off + 3] = Number((b >> 1n) & 0xffn);
  // Byte 4: bit 7 = base[0], bits 6-1 = reserved, bit 0 = ext[8]. Preserve
  // the original lower 7 bits so reserved bits and ext[8] stay intact.
  buf[off + 4] = (Number(b & 1n) << 7) | (buf[off + 4] & 0x7f);
}

// Stream IDs whose PES packets do NOT carry a PTS/DTS field.
// (H.222.0 §2.4.3.7 lists these — program_stream_map, padding_stream, etc.)
const PES_NO_PTS_STREAM_IDS = new Set<number>([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xff, 0xf2, 0xf8]);

function processPacket(packet: Buffer, offset90kHz: bigint, ctx: PacketContext): void {
  if (packet[0] !== TS_SYNC_BYTE) {
    throw new Error(`MPEG-TS sync byte missing (got 0x${packet[0].toString(16)})`);
  }

  const pid = ((packet[1] & 0x1f) << 8) | packet[2];
  const pusi = (packet[1] & 0x40) !== 0;
  const afc = (packet[3] >> 4) & 0x03;
  const hasAF = (afc & 0x02) !== 0;
  const hasPayload = (afc & 0x01) !== 0;

  // Continuity counter is incremented per spec only on payload-bearing
  // packets. We rewrite with our own running counter so the CC sequence is
  // continuous across file boundaries.
  if (hasPayload) {
    const last = ctx.ccByPid.get(pid);
    const next = last === undefined ? packet[3] & 0x0f : (last + 1) & 0x0f;
    packet[3] = (packet[3] & 0xf0) | next;
    ctx.ccByPid.set(pid, next);
  }

  let payloadStart = 4;

  if (hasAF) {
    const afLength = packet[4];
    if (afLength > 0) {
      const flags = packet[5];
      const pcrFlag = (flags & 0x10) !== 0;
      if (pcrFlag) {
        const base = readPCRBase(packet, 6);
        const newBase = (base + offset90kHz) & 0x1ffffffffn;
        writePCRBase(packet, 6, newBase);
        const pcrSec = Number(newBase) / PTS_HZ;
        if (pcrSec > ctx.latestStreamTimeSec) ctx.latestStreamTimeSec = pcrSec;
      }
    }
    payloadStart = 5 + afLength;
  }

  // PES header lives in PUSI=1 packets that have a payload. Its first three
  // bytes are 0x00 0x00 0x01 (start code prefix); byte 3 is stream_id.
  if (hasPayload && pusi && payloadStart + 9 < TS_PACKET_SIZE) {
    const p = payloadStart;
    if (packet[p] === 0x00 && packet[p + 1] === 0x00 && packet[p + 2] === 0x01) {
      const streamId = packet[p + 3];
      if (!PES_NO_PTS_STREAM_IDS.has(streamId)) {
        const ptsDtsFlags = (packet[p + 7] >> 6) & 0x03;
        if (ptsDtsFlags === 0x02) {
          // PTS only.
          const pts = readTimestamp33(packet, p + 9);
          const newPts = (pts + offset90kHz) & 0x1ffffffffn;
          writeTimestamp33(packet, p + 9, newPts, 0x02);
          const ptsSec = Number(newPts) / PTS_HZ;
          if (ptsSec > ctx.latestStreamTimeSec) ctx.latestStreamTimeSec = ptsSec;
        } else if (ptsDtsFlags === 0x03) {
          // PTS + DTS.
          const pts = readTimestamp33(packet, p + 9);
          const newPts = (pts + offset90kHz) & 0x1ffffffffn;
          writeTimestamp33(packet, p + 9, newPts, 0x03);
          const dts = readTimestamp33(packet, p + 14);
          const newDts = (dts + offset90kHz) & 0x1ffffffffn;
          writeTimestamp33(packet, p + 14, newDts, 0x01);
          const ptsSec = Number(newPts) / PTS_HZ;
          if (ptsSec > ctx.latestStreamTimeSec) ctx.latestStreamTimeSec = ptsSec;
        }
      }
    }
  }
}

// ── Mux + transcode (unchanged from the previous iteration) ──────────────────

async function createLiveStream(mux: Mux): Promise<LiveStreamCreds> {
  // No new_asset_settings — Mux still creates an asset on ingest with defaults,
  // but we delete it during cleanup anyway. Less to think about.
  const liveStream = await mux.video.liveStreams.create({
    playback_policies: ['public'],
    audio_only: true,
    latency_mode: 'low',
  });

  const playbackId = liveStream.playback_ids?.[0]?.id;
  if (!liveStream.stream_key || !liveStream.srt_passphrase || !playbackId) {
    throw new Error(
      `Mux live stream response missing fields: ${JSON.stringify({
        hasStreamKey: !!liveStream.stream_key,
        hasSrtPassphrase: !!liveStream.srt_passphrase,
        hasPlaybackId: !!playbackId,
      })}`,
    );
  }

  return {
    id: liveStream.id,
    streamKey: liveStream.stream_key,
    srtPassphrase: liveStream.srt_passphrase,
    playbackId,
  };
}

// eslint-disable-next-line no-unused-vars -- intentionally kept while caller is commented out for iteration
async function cleanupMux(mux: Mux, liveStreamId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let assetIds: string[] = [];
  try {
    const liveStream = await mux.video.liveStreams.retrieve(liveStreamId);
    assetIds = liveStream.recent_asset_ids ?? [];
  } catch (err) {
    console.error(`[mux] retrieve for cleanup failed:`, err);
  }

  for (const assetId of assetIds) {
    try {
      await mux.video.assets.delete(assetId);
    } catch (err) {
      console.error(`[mux] failed to delete asset ${assetId}:`, err);
    }
  }

  try {
    await mux.video.liveStreams.delete(liveStreamId);
  } catch (err) {
    console.error(`[mux] failed to delete live stream ${liveStreamId}:`, err);
  }

  console.log(`[mux] cleanup: deleted ${assetIds.length} asset(s) + livestream ${liveStreamId}`);
}

async function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', reject);
    ff.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited code=${code} signal=${signal}`));
    });
  });
}

async function transcodeOne(mp3Path: string, tsPath: string): Promise<void> {
  // AAC-LC (built-in `aac` encoder, ffmpeg-static includes it) CBR 160k in MPEG-TS.
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    mp3Path,
    '-map_metadata',
    '-1',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-f',
    'mpegts',
    tsPath,
  ]);
}

async function transcodeSource(): Promise<{ mp3Path: string; tsPath: string }> {
  await fs.promises.mkdir(TS_DIR, { recursive: true });
  const mp3Path = path.join(AUDIO_DIR, `${SOURCE_BASENAME}.mp3`);
  const tsPath = path.join(TS_DIR, `${SOURCE_BASENAME}.ts`);
  console.log(`[transcode] ${mp3Path} → ${tsPath}`);
  await transcodeOne(mp3Path, tsPath);
  return { mp3Path, tsPath };
}

// ── SRT caller + diagnostics ─────────────────────────────────────────────────

async function openSrtCaller(creds: LiveStreamCreds): Promise<{
  asyncSrt: AsyncSRTWithDispose;
  socket: number;
  getError: () => Error | null;
  stopDiagnostics: () => void;
}> {
  setSRTLoggingLevel(5); // NOTE

  const asyncSrt = new AsyncSRT() as AsyncSRTWithDispose;

  // The worker thread emits 'error' on libsrt errors. Without a listener,
  // Node throws ERR_UNHANDLED_ERROR. We also record the *first* error in a
  // sticky variable so subsequent SRT calls can short-circuit instead of
  // hanging — @eyevinn/srt has a bug where post-error calls have their
  // callbacks shifted off the queue without being invoked, so awaiting them
  // is forever. getError() lets the streaming loop fail fast.
  let stickyError: Error | null = null;
  asyncSrt.on('error', (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    stickyError ??= e;
    console.error('[srt async error]', err);
  });

  const socket = await asyncSrt.createSocket(true);

  await asyncSrt.setSockOpt(socket, SRTO_TRANSTYPE, SRTT_LIVE);
  await asyncSrt.setSockOpt(socket, SRTO_CONNTIMEO, MUX_SRT_CONN_TIMEOUT_MS);
  await asyncSrt.setSockOpt(socket, SRTO_STREAMID, creds.streamKey);
  await asyncSrt.setSockOpt(socket, SRTO_PASSPHRASE, creds.srtPassphrase);
  await asyncSrt.setSockOpt(socket, SRTO_PBKEYLEN, 16);
  await asyncSrt.setSockOpt(socket, SRTO_LATENCY, MUX_SRT_LATENCY_MS);

  // Passphrase intentionally omitted from logs — streamid stays so we can
  // cross-reference the Mux dashboard when something goes wrong.
  console.log(
    `[srt] url: srt://${MUX_SRT_HOST}:${MUX_SRT_PORT}` +
      `?streamid=${creds.streamKey}&passphrase=<redacted>` +
      `&pbkeylen=16&latency=${MUX_SRT_LATENCY_MS}`,
  );

  // @eyevinn/srt's native binding uses inet_pton(AF_INET, host, ...) which only
  // parses IPv4 literals — it does NOT do DNS resolution. Resolve in JS first.
  const { address: ipv4 } = await lookup(MUX_SRT_HOST, { family: 4 });
  console.log(`[srt] resolved ${MUX_SRT_HOST} → ${ipv4}, connecting…`);

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
  console.log(`[srt] connected.`);

  let diagRunning = true;
  const diagInterval = setInterval(async () => {
    if (!diagRunning || stickyError) return;
    const timeoutMarker = Symbol('timeout');
    const withTimeout = <T>(p: Promise<T>): Promise<T | typeof timeoutMarker> =>
      Promise.race([
        p,
        new Promise<typeof timeoutMarker>((r) => setTimeout(() => r(timeoutMarker), 1000)),
      ]);
    try {
      const stateResult = await withTimeout(asyncSrt.getSockState(socket));
      const statsResult = await withTimeout(asyncSrt.stats(socket, false));
      if (stateResult === timeoutMarker || statsResult === timeoutMarker) {
        console.log('[srt diag] poll timed out (worker stuck?)');
        return;
      }
      const stateName = SOCK_STATE_NAMES[stateResult as number] ?? `unknown(${stateResult})`;
      const s = statsResult as Awaited<ReturnType<typeof asyncSrt.stats>>;
      console.log(
        `[srt diag] state=${stateName} rtt=${s.msRTT?.toFixed(1)}ms ` +
          `bw=${s.mbpsBandwidth?.toFixed(2)}Mbps ` +
          `sndLossTotal=${s.pktSndLossTotal} retransTotal=${s.pktRetransTotal} ` +
          `sndDropTotal=${s.byteSndDropTotal}b ` +
          `sndBuf=${s.byteSndBuf}b/${s.msSndBuf}ms ` +
          `pktSent=${s.pktSentTotal} flightSize=${s.pktFlightSize}`,
      );
    } catch (err) {
      console.error('[srt diag] error:', err);
    }
  }, 5000);
  const stopDiagnostics = (): void => {
    diagRunning = false;
    clearInterval(diagInterval);
  };

  return { asyncSrt, socket, getError: () => stickyError, stopDiagnostics };
}

// ── Streaming: read .ts file, rewrite packets, send to SRT ───────────────────

async function streamFileViaPackets(
  asyncSrt: AsyncSRTWithDispose,
  socket: number,
  tsPath: string,
  offsetSec: number,
  ctx: PacketContext,
  pacing: PacingState,
  getError: () => Error | null,
): Promise<{ packetsSent: number; lastStreamTimeSec: number }> {
  const offset90kHz = BigInt(Math.round(offsetSec * PTS_HZ));

  // Race each SRT write against AsyncSRT's next 'error' event so a broken
  // socket fails the write quickly instead of hanging.
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

  // Sleep if writing the next chunk would push us > PACING_LEAD_SEC ahead.
  // ctx.latestStreamTimeSec is updated by processPacket from each packet's
  // PCR/PTS — pacing reads the ground truth straight out of the bytes.
  async function paceBeforeWrite(): Promise<void> {
    if (pacing.startMs === null) {
      pacing.startMs = performance.now();
      return;
    }
    const elapsedSec = (performance.now() - pacing.startMs) / 1000;
    const lead = ctx.latestStreamTimeSec - elapsedSec;
    if (lead > PACING_LEAD_SEC) await sleep((lead - PACING_LEAD_SEC) * 1000);
  }

  const fileHandle = await fs.promises.open(tsPath, 'r');
  // Buffer one SRT chunk worth of packets (1316 bytes = 7 packets).
  const chunkBuf = Buffer.alloc(SRT_CHUNK_SIZE);
  let packetsInChunk = 0;
  let packetsSent = 0;

  try {
    while (true) {
      const off = packetsInChunk * TS_PACKET_SIZE;
      const { bytesRead } = await fileHandle.read(chunkBuf, off, TS_PACKET_SIZE, null);
      if (bytesRead === 0) break;
      if (bytesRead !== TS_PACKET_SIZE) {
        console.warn(`[srt] short TS packet (${bytesRead}b) at end of ${tsPath}; ignoring`);
        break;
      }

      const packet = chunkBuf.subarray(off, off + TS_PACKET_SIZE);
      processPacket(packet, offset90kHz, ctx);
      packetsInChunk++;
      packetsSent++;

      if (packetsInChunk === TS_PACKETS_PER_SRT_CHUNK) {
        await paceBeforeWrite();
        const out = Buffer.allocUnsafeSlow(SRT_CHUNK_SIZE);
        chunkBuf.copy(out);
        const result = await srtWrite(out);
        if (result === SRT_ERROR) {
          throw new Error(`SRT write returned SRT_ERROR after ${packetsSent} packets`);
        }
        packetsInChunk = 0;
      }
    }

    // Flush any partial chunk (most files end on a 7-packet boundary, but
    // not guaranteed).
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

async function main(): Promise<void> {
  const sourceMp3 = path.join(AUDIO_DIR, `${SOURCE_BASENAME}.mp3`);
  if (!fs.existsSync(sourceMp3)) throw new Error(`Missing input: ${sourceMp3}`);

  const mux = new Mux({
    tokenId: readEnv('MUX_TOKEN_ID'),
    tokenSecret: readEnv('MUX_TOKEN_SECRET'),
  });

  console.log('[mux] creating audio-only live stream…');
  const creds = await createLiveStream(mux);
  console.log(
    `[mux] live stream created: id=${creds.id} playback=https://stream.mux.com/${creds.playbackId}.m3u8`,
  );

  try {
    console.log('[transcode] starting');
    const { mp3Path, tsPath } = await transcodeSource();

    // Source-MP3 duration is close enough to .ts duration for our offset
    // purposes (a few tens of ms of AAC encoder priming/padding). The packet
    // rewriter shifts every PCR/PTS/DTS by `cumulativeOffsetSec * 90000` so
    // each repeat picks up where the prior one left off.
    const meta = await parseFile(mp3Path);
    const durationSec = meta.format.duration ?? 0;
    if (durationSec <= 0) throw new Error(`music-metadata returned no duration for ${mp3Path}`);
    const totalDurationSec = durationSec * STREAM_REPEATS;
    console.log(
      `[srt] streaming ${tsPath} ${STREAM_REPEATS}× ` +
        `(${durationSec.toFixed(2)}s each, ${totalDurationSec.toFixed(2)}s total)`,
    );

    const { asyncSrt, socket, getError, stopDiagnostics } = await openSrtCaller(creds);

    try {
      const pacing: PacingState = { startMs: null };
      const ctx: PacketContext = { ccByPid: new Map(), latestStreamTimeSec: 0 };
      const startMs = performance.now();

      let cumulativeOffsetSec = 0;
      for (let i = 0; i < STREAM_REPEATS; i++) {
        console.log(
          `[srt] streaming ${tsPath} repeat=${i + 1}/${STREAM_REPEATS} ` +
            `(offset=${cumulativeOffsetSec.toFixed(3)}s)…`,
        );
        const { packetsSent, lastStreamTimeSec } = await streamFileViaPackets(
          asyncSrt,
          socket,
          tsPath,
          cumulativeOffsetSec,
          ctx,
          pacing,
          getError,
        );
        console.log(
          `[srt] sent ${packetsSent} packets for repeat=${i + 1} ` +
            `(last stream-time ${lastStreamTimeSec.toFixed(3)}s)`,
        );
        cumulativeOffsetSec += durationSec;
      }
      const elapsedMs = Math.round(performance.now() - startMs);
      console.log(`[srt] all repeats streamed in ${elapsedMs} ms`);

      // Hold the connection open until ~30s past expected playback end so
      // Mux finishes publishing trailing HLS segments.
      if (pacing.startMs !== null) {
        const totalDurationSec = ctx.latestStreamTimeSec;
        const elapsedFromFirstByteSec = (performance.now() - pacing.startMs) / 1000;
        const remainingPlaybackSec = Math.max(0, totalDurationSec - elapsedFromFirstByteSec);
        const holdSec = remainingPlaybackSec + TAIL_HOLD_SEC;
        console.log(
          `[srt] holding connection ${holdSec.toFixed(1)}s ` +
            `(${remainingPlaybackSec.toFixed(1)}s remaining playback + ${TAIL_HOLD_SEC}s tail)`,
        );
        await sleep(holdSec * 1000);
      }
    } finally {
      stopDiagnostics();
      await Promise.race([
        asyncSrt.close(socket).catch((err) => console.error('[srt] close error:', err)),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      await asyncSrt.dispose();
    }

    console.log('[done] stream complete — check Mux dashboard / playback URL');
    console.log(`        https://stream.mux.com/${creds.playbackId}.m3u8`);
  } finally {
    // Disabled while iterating so we can inspect the asset post-run.
    // await cleanupMux(mux, creds.id);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
