import { describe, it, expect } from 'vitest';

import {
  PTS_HZ,
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
  processPacket,
  readPCRBase,
  readTimestamp33,
  writePCRBase,
  writeTimestamp33,
  type PacketContext,
} from '@src/lib/streaming/mpegts.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function emptyPacket(): Buffer {
  const buf = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  buf[0] = TS_SYNC_BYTE;
  return buf;
}

/**
 * Build a TS packet header with the given fields.
 *   pid: 13-bit
 *   pusi: payload unit start indicator
 *   afc: 2-bit adaptation field control (1=payload only, 2=AF only, 3=AF+payload)
 *   cc: 4-bit continuity counter
 */
function packetWithHeader({
  pid,
  pusi = false,
  afc,
  cc,
}: {
  pid: number;
  pusi?: boolean;
  afc: number;
  cc: number;
}): Buffer {
  const buf = emptyPacket();
  buf[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  buf[2] = pid & 0xff;
  buf[3] = ((afc & 0x03) << 4) | (cc & 0x0f);
  return buf;
}

function freshContext(): PacketContext {
  return { ccByPid: new Map(), latestStreamTimeSec: 0 };
}

function freshContextAt(latestSec: number): PacketContext {
  return { ccByPid: new Map(), latestStreamTimeSec: latestSec };
}

// ── readTimestamp33 / writeTimestamp33 ──────────────────────────────────────

describe('readTimestamp33 / writeTimestamp33', () => {
  it('round-trips a 33-bit timestamp value', () => {
    const buf = Buffer.alloc(5);
    const value = 1234567890n; // ~3.8h at 90 kHz
    writeTimestamp33(buf, 0, value, 0x02);
    expect(readTimestamp33(buf, 0)).toBe(value);
  });

  it('round-trips zero', () => {
    const buf = Buffer.alloc(5);
    writeTimestamp33(buf, 0, 0n, 0x02);
    expect(readTimestamp33(buf, 0)).toBe(0n);
  });

  it('round-trips the maximum 33-bit value', () => {
    const buf = Buffer.alloc(5);
    const max33 = 0x1ffffffffn;
    writeTimestamp33(buf, 0, max33, 0x02);
    expect(readTimestamp33(buf, 0)).toBe(max33);
  });

  it('writes the prefix into the high nibble of byte 0', () => {
    const buf = Buffer.alloc(5);
    writeTimestamp33(buf, 0, 0n, 0x03); // PTS+DTS prefix
    expect((buf[0] >> 4) & 0x0f).toBe(0x03);
    writeTimestamp33(buf, 0, 0n, 0x02); // PTS-only prefix
    expect((buf[0] >> 4) & 0x0f).toBe(0x02);
  });

  it('writes the marker bits at byte 0 bit 0, byte 2 bit 0, byte 4 bit 0', () => {
    const buf = Buffer.alloc(5);
    writeTimestamp33(buf, 0, 0n, 0x02);
    expect(buf[0] & 0x01).toBe(0x01);
    expect(buf[2] & 0x01).toBe(0x01);
    expect(buf[4] & 0x01).toBe(0x01);
  });

  it('round-trips a value at a non-zero offset', () => {
    const buf = Buffer.alloc(20);
    const value = 0x123456789n;
    writeTimestamp33(buf, 7, value, 0x02);
    expect(readTimestamp33(buf, 7)).toBe(value);
  });
});

// ── readPCRBase / writePCRBase ──────────────────────────────────────────────

describe('readPCRBase / writePCRBase', () => {
  it('round-trips a 33-bit PCR base value', () => {
    const buf = Buffer.alloc(6);
    const value = 99999999n;
    writePCRBase(buf, 0, value);
    expect(readPCRBase(buf, 0)).toBe(value);
  });

  it('round-trips zero', () => {
    const buf = Buffer.alloc(6);
    writePCRBase(buf, 0, 0n);
    expect(readPCRBase(buf, 0)).toBe(0n);
  });

  it('round-trips the maximum 33-bit value', () => {
    const buf = Buffer.alloc(6);
    const max33 = 0x1ffffffffn;
    writePCRBase(buf, 0, max33);
    expect(readPCRBase(buf, 0)).toBe(max33);
  });

  it('preserves the lower 7 bits of byte 4 (reserved + ext[8])', () => {
    const buf = Buffer.alloc(6);
    // Pre-populate byte 4 with all 6 reserved bits set (per spec) and ext[8]=1.
    buf[4] = 0x7f;
    writePCRBase(buf, 0, 0n);
    expect(buf[4] & 0x7f).toBe(0x7f);
  });

  it('round-trips at a non-zero offset', () => {
    const buf = Buffer.alloc(20);
    const value = 0x1abcdef89n;
    writePCRBase(buf, 7, value);
    expect(readPCRBase(buf, 7)).toBe(value);
  });
});

// ── processPacket ───────────────────────────────────────────────────────────

describe('processPacket', () => {
  it('throws when the sync byte is missing', () => {
    const buf = packetWithHeader({ pid: 0x100, afc: 1, cc: 0 });
    buf[0] = 0x00;
    const ctx = freshContext();
    expect(() => processPacket(buf, 0n, ctx)).toThrow(/sync byte missing/i);
  });

  it('rewrites the continuity counter for payload-bearing packets', () => {
    const ctx = freshContext();
    const p1 = packetWithHeader({ pid: 0x100, afc: 1, cc: 0 });
    processPacket(p1, 0n, ctx);
    expect(p1[3] & 0x0f).toBe(0x00);

    const p2 = packetWithHeader({ pid: 0x100, afc: 1, cc: 5 });
    processPacket(p2, 0n, ctx);
    expect(p2[3] & 0x0f).toBe(0x01);

    const p3 = packetWithHeader({ pid: 0x100, afc: 1, cc: 8 });
    processPacket(p3, 0n, ctx);
    expect(p3[3] & 0x0f).toBe(0x02);
  });

  it('keeps separate continuity counters per PID', () => {
    const ctx = freshContext();
    processPacket(packetWithHeader({ pid: 0x100, afc: 1, cc: 0 }), 0n, ctx);
    processPacket(packetWithHeader({ pid: 0x200, afc: 1, cc: 0 }), 0n, ctx);
    const next100 = packetWithHeader({ pid: 0x100, afc: 1, cc: 9 });
    processPacket(next100, 0n, ctx);
    // Two writes for PID 0x100: 0 then 1.
    expect(next100[3] & 0x0f).toBe(0x01);
  });

  it('wraps the continuity counter at 16', () => {
    const ctx = freshContext();
    // Seed PID 0x100 with cc=15.
    ctx.ccByPid.set(0x100, 15);
    const p = packetWithHeader({ pid: 0x100, afc: 1, cc: 0 });
    processPacket(p, 0n, ctx);
    expect(p[3] & 0x0f).toBe(0x00);
  });

  it('does not advance the continuity counter on adaptation-field-only packets', () => {
    const ctx = freshContext();
    // afc=2 means AF only, no payload — CC should not advance.
    ctx.ccByPid.set(0x100, 7);
    const p = packetWithHeader({ pid: 0x100, afc: 2, cc: 0 });
    p[4] = 0; // adaptation_field_length = 0
    processPacket(p, 0n, ctx);
    expect(ctx.ccByPid.get(0x100)).toBe(7);
  });

  it('shifts PCR base by the offset (90 kHz ticks)', () => {
    const ctx = freshContext();
    const p = packetWithHeader({ pid: 0x100, afc: 3, cc: 0 });
    p[4] = 7; // adaptation_field_length: PCR (6 bytes) + flags byte
    p[5] = 0x10; // flags: PCR_flag set
    writePCRBase(p, 6, 90_000n); // 1 second
    p[10] |= 0x7e; // reserved bits set per spec
    p[11] = 0; // ext = 0

    processPacket(p, 90_000n, ctx); // shift +1 second

    expect(readPCRBase(p, 6)).toBe(180_000n);
    expect(ctx.latestStreamTimeSec).toBe(2); // 180_000 / 90_000
  });

  it('does not touch PCR when PCR_flag is unset', () => {
    const ctx = freshContext();
    const p = packetWithHeader({ pid: 0x100, afc: 3, cc: 0 });
    p[4] = 1; // adaptation_field_length: just the flags byte
    p[5] = 0x00; // no PCR_flag
    processPacket(p, 90_000n, ctx);
    expect(ctx.latestStreamTimeSec).toBe(0);
  });
});

describe('processPacket — PES header rewriting', () => {
  /** Build a packet whose payload starts with a PES header carrying a PTS. */
  function packetWithPesPTS({
    pid,
    cc,
    streamId,
    pts,
  }: {
    pid: number;
    cc: number;
    streamId: number;
    pts: bigint;
  }): Buffer {
    const p = packetWithHeader({ pid, pusi: true, afc: 1, cc });
    // PES header at payload offset (= 4, no AF).
    p[4] = 0x00;
    p[5] = 0x00;
    p[6] = 0x01;
    p[7] = streamId;
    p[8] = 0; // PES_packet_length high byte
    p[9] = 0; // PES_packet_length low byte
    p[10] = 0x80; // marker '10' + flags
    p[11] = 0x80; // PTS_DTS_flags = '10' (PTS only)
    p[12] = 5; // PES_header_data_length
    writeTimestamp33(p, 13, pts, 0x02);
    return p;
  }

  /** PES with PTS+DTS — DTS sits at byte 18 in our layout. */
  function packetWithPesPTSDTS({
    pid,
    cc,
    streamId,
    pts,
    dts,
  }: {
    pid: number;
    cc: number;
    streamId: number;
    pts: bigint;
    dts: bigint;
  }): Buffer {
    const p = packetWithHeader({ pid, pusi: true, afc: 1, cc });
    p[4] = 0x00;
    p[5] = 0x00;
    p[6] = 0x01;
    p[7] = streamId;
    p[8] = 0;
    p[9] = 0;
    p[10] = 0x80;
    p[11] = 0xc0; // PTS_DTS_flags = '11' (PTS+DTS)
    p[12] = 10; // PES_header_data_length
    writeTimestamp33(p, 13, pts, 0x03);
    writeTimestamp33(p, 18, dts, 0x01);
    return p;
  }

  it('shifts PTS in a PTS-only PES header', () => {
    const ctx = freshContext();
    const original = 90_000n;
    const offset = 90_000n * 5n; // +5 seconds
    const p = packetWithPesPTS({ pid: 0x100, cc: 0, streamId: 0xc0, pts: original });
    processPacket(p, offset, ctx);
    expect(readTimestamp33(p, 13)).toBe(original + offset);
    expect(ctx.latestStreamTimeSec).toBe(6); // (90_000 + 450_000) / 90_000
  });

  it('shifts both PTS and DTS in a PTS+DTS PES header', () => {
    const ctx = freshContext();
    const pts = 90_000n * 10n;
    const dts = 90_000n * 9n;
    const offset = 90_000n * 100n;
    const p = packetWithPesPTSDTS({
      pid: 0x100,
      cc: 0,
      streamId: 0xe0,
      pts,
      dts,
    });
    processPacket(p, offset, ctx);
    expect(readTimestamp33(p, 13)).toBe(pts + offset);
    expect(readTimestamp33(p, 18)).toBe(dts + offset);
    // latestStreamTimeSec follows the (post-shift) PTS, not DTS.
    expect(ctx.latestStreamTimeSec).toBe(110);
  });

  it('does not touch PTS for PES stream IDs without PES extension headers', () => {
    const ctx = freshContext();
    const original = 90_000n;
    // 0xbe = padding_stream — listed in PES_NO_PTS_STREAM_IDS.
    const p = packetWithPesPTS({ pid: 0x100, cc: 0, streamId: 0xbe, pts: original });
    processPacket(p, 90_000n * 50n, ctx);
    // PTS bytes should not have been modified.
    expect(readTimestamp33(p, 13)).toBe(original);
    expect(ctx.latestStreamTimeSec).toBe(0);
  });

  it('does not touch payload when PUSI is false', () => {
    const ctx = freshContext();
    // Same byte layout, but no PUSI — looks like a PES continuation packet.
    const p = packetWithPesPTS({ pid: 0x100, cc: 0, streamId: 0xc0, pts: 90_000n });
    p[1] &= ~0x40; // clear PUSI
    processPacket(p, 90_000n * 50n, ctx);
    expect(readTimestamp33(p, 13)).toBe(90_000n);
  });

  it('keeps latestStreamTimeSec monotonic across packets', () => {
    const ctx = freshContextAt(50);
    const p = packetWithPesPTS({ pid: 0x100, cc: 0, streamId: 0xc0, pts: 90_000n }); // 1s post-shift if offset=0
    processPacket(p, 0n, ctx);
    // 1s < existing 50s; latestStreamTimeSec should not regress.
    expect(ctx.latestStreamTimeSec).toBe(50);
  });

  it('exposes PTS_HZ as 90_000', () => {
    expect(PTS_HZ).toBe(90_000);
  });
});
