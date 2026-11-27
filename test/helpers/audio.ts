// Real-ffmpeg helpers for encoding pipeline tests.
//
// These deliberately shell out to the `ffmpeg` / `ffprobe` binaries directly
// rather than going through anything in src/, so the assertions stay valid no
// matter how the production code wires itself up to ffmpeg.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface SineOptions {
  seconds: number;
  sampleRate: number;
  channels: 1 | 2;
  bitrate: string;
}

/**
 * Writes an MP3 test tone to `outputPath`. Pick a sample rate / channel count
 * that differs from the pipeline's output (44.1kHz stereo) so tests can tell
 * the file was actually re-encoded rather than copied through.
 */
export async function writeSineMp3(outputPath: string, opts: SineOptions): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${opts.sampleRate}:duration=${opts.seconds}`,
    '-ac',
    String(opts.channels),
    '-c:a',
    'libmp3lame',
    '-b:a',
    opts.bitrate,
    '-y',
    outputPath,
  ]);
}

export interface ProbeResult {
  formatName: string;
  codecName: string;
  sampleRate: number;
  channels: number;
  duration: number;
}

/** Reads container + first audio stream info via ffprobe. */
export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'a:0',
    filePath,
  ]);
  const info = JSON.parse(stdout) as {
    format: { format_name: string; duration: string };
    streams: { codec_name: string; sample_rate: string; channels: number }[];
  };
  const [stream] = info.streams;
  if (!stream) throw new Error(`ffprobe found no audio stream in ${filePath}`);
  return {
    formatName: info.format.format_name,
    codecName: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    duration: Number(info.format.duration),
  };
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
