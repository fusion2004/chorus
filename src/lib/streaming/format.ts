/**
 * Encoding conventions per streaming backend.
 *
 *   icecast  →  MP3 (libmp3lame, 256k, in MP3 container) — what we ship today
 *   mux      →  AAC-LC (built-in `aac` encoder, 160k, in MPEG-TS container)
 *
 * Songs and announcers go through one transcode pass per backend; the source
 * download / Polly raw output remain MP3 regardless because they pre-date the
 * backend choice.
 */

import type { StreamingMode } from './types.js';

/** File extension for backend-encoded audio (transcoded songs + announcers). */
export function encodedExt(streamTo: StreamingMode): string {
  return streamTo === 'mux' ? 'ts' : 'mp3';
}

/**
 * The codec/bitrate/container portion of an FFmpeg argv. Combine with
 * input-side flags (`-analyzeduration 0 -loglevel 0 -map_metadata -1 -ar
 * 44100 -ac 2` and any `-filter:a ...`) to form the full args list.
 */
export function ffmpegOutputArgs(streamTo: StreamingMode): string[] {
  if (streamTo === 'mux') {
    return ['-c:a', 'aac', '-b:a', '160k', '-f', 'mpegts'];
  }
  return ['-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3'];
}
