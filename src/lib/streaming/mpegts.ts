/**
 * MPEG-TS packet rewriter — rewrites continuity counters, PCR, and PTS/DTS
 * in 188-byte transport stream packets in place. Used by the Mux streaming
 * backend so PCR/PTS/DTS stay monotonic across "file" boundaries (each .ts
 * file we feed Mux otherwise restarts those clocks at 0, which Mux rejects).
 *
 * Pure functions, no I/O. The caller reads packets from disk, hands each one
 * here, and writes the (mutated) buffer back to the wire.
 *
 * Lifted from src/srt-spike.ts (commit b1fc369).
 */

/** MPEG-TS packets are a fixed 188 bytes starting with sync byte 0x47. */
export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;

/** PTS/DTS and PCR base are all 90 kHz ticks. */
export const PTS_HZ = 90_000;

/**
 * Per-packet processing context, carried across all packets of a streaming
 * session so CC counters stay continuous across file boundaries and the
 * latest stream-time can drive sender-side pacing.
 */
export interface PacketContext {
  /** Per-PID running 4-bit continuity counter. */
  ccByPid: Map<number, number>;
  /**
   * Most recent PTS/PCR (in seconds, post-offset) embedded in a packet.
   * Pacing reads this to decide when to throttle the sender.
   */
  latestStreamTimeSec: number;
}

// ── Field accessors ───────────────────────────────────────────────────────────
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

export function readTimestamp33(buf: Buffer, off: number): bigint {
  return (
    (BigInt((buf[off] >> 1) & 0x07) << 30n) |
    (BigInt(buf[off + 1]) << 22n) |
    (BigInt((buf[off + 2] >> 1) & 0x7f) << 15n) |
    (BigInt(buf[off + 3]) << 7n) |
    BigInt((buf[off + 4] >> 1) & 0x7f)
  );
}

export function writeTimestamp33(buf: Buffer, off: number, value: bigint, prefix: number): void {
  const v = value & 0x1ffffffffn;
  buf[off] = (prefix << 4) | (Number((v >> 30n) & 0x07n) << 1) | 0x01;
  buf[off + 1] = Number((v >> 22n) & 0xffn);
  buf[off + 2] = (Number((v >> 15n) & 0x7fn) << 1) | 0x01;
  buf[off + 3] = Number((v >> 7n) & 0xffn);
  buf[off + 4] = (Number(v & 0x7fn) << 1) | 0x01;
}

export function readPCRBase(buf: Buffer, off: number): bigint {
  return (
    (BigInt(buf[off]) << 25n) |
    (BigInt(buf[off + 1]) << 17n) |
    (BigInt(buf[off + 2]) << 9n) |
    (BigInt(buf[off + 3]) << 1n) |
    BigInt(buf[off + 4] >> 7)
  );
}

export function writePCRBase(buf: Buffer, off: number, base: bigint): void {
  const b = base & 0x1ffffffffn;
  buf[off] = Number((b >> 25n) & 0xffn);
  buf[off + 1] = Number((b >> 17n) & 0xffn);
  buf[off + 2] = Number((b >> 9n) & 0xffn);
  buf[off + 3] = Number((b >> 1n) & 0xffn);
  // Byte 4: bit 7 = base[0], bits 6-1 = reserved, bit 0 = ext[8]. Preserve
  // the original lower 7 bits so reserved bits and ext[8] stay intact.
  buf[off + 4] = (Number(b & 1n) << 7) | (buf[off + 4] & 0x7f);
}

/**
 * PES stream IDs whose packets do NOT carry a PTS/DTS field
 * (H.222.0 §2.4.3.7 — program_stream_map, padding_stream, etc.).
 */
const PES_NO_PTS_STREAM_IDS = new Set<number>([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xff, 0xf2, 0xf8]);

/**
 * Rewrite one 188-byte MPEG-TS packet in place:
 *   - Continuity counter is replaced with a per-PID running counter (so CC
 *     stays continuous across file boundaries).
 *   - PCR base in the adaptation field is shifted by `offset90kHz`.
 *   - PTS / DTS in the PES header (PUSI=1 packets) are shifted by `offset90kHz`.
 *
 * Updates `ctx.latestStreamTimeSec` to the largest PTS/PCR seen so far (in
 * seconds, post-offset) so the caller's pacing logic can throttle.
 */
export function processPacket(packet: Buffer, offset90kHz: bigint, ctx: PacketContext): void {
  if (packet[0] !== TS_SYNC_BYTE) {
    throw new Error(`MPEG-TS sync byte missing (got 0x${packet[0].toString(16)})`);
  }

  const pid = ((packet[1] & 0x1f) << 8) | packet[2];
  const pusi = (packet[1] & 0x40) !== 0;
  const afc = (packet[3] >> 4) & 0x03;
  const hasAF = (afc & 0x02) !== 0;
  const hasPayload = (afc & 0x01) !== 0;

  // Continuity counter increments per spec only on payload-bearing packets.
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
