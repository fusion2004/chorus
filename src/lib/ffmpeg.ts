import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { ffmpegOutputArgs } from './streaming/format.js';
import type { StreamingMode } from './streaming/types.js';

// We run whichever `ffmpeg` is on PATH: in production and CI that's our build from thasauce-apt.
const FFMPEG_BIN = 'ffmpeg';

// Enough of the end of stderr to explain a failure without holding a whole log in memory.
const STDERR_TAIL_BYTES = 4096;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Runs ffmpeg with `args` and resolves once it exits 0. Rejects with an FfmpegError carrying the end of ffmpeg's
 * stderr otherwise. ffmpeg gets no stdin and its stdout is discarded, so pass it file paths, not pipes.
 */
export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    // 'error' covers failing to start at all (e.g. ENOENT when ffmpeg isn't installed). If it fires, 'close' may still
    // follow, and the second settle is a no-op.
    child.on('error', (err) => {
      reject(new FfmpegError(`Could not run ${FFMPEG_BIN}: ${err.message}`, null, null, stderr));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const status = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      const detail = stderr.trim();
      reject(
        new FfmpegError(
          `${FFMPEG_BIN} ${status}${detail ? `: ${detail}` : ''}`,
          code,
          signal,
          stderr,
        ),
      );
    });
  });
}

// Normalizes the announcer's loudness (EBU R128: -16 LUFS integrated, -1.5 dBTP peak).
export const ANNOUNCER_LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';

interface EncodeOptions {
  /** An ffmpeg audio filter graph to apply, e.g. ANNOUNCER_LOUDNORM. */
  audioFilter?: string;
}

/**
 * Encodes the first audio stream of `inputPath` into the format `streamTo` streams (44.1kHz stereo, no metadata) and
 * writes it to `outputPath`, overwriting it. On failure, whatever ffmpeg wrote to `outputPath` is removed.
 */
export async function encodeAudio(
  inputPath: string,
  outputPath: string,
  streamTo: StreamingMode,
  { audioFilter }: EncodeOptions = {},
): Promise<void> {
  const args = [
    '-i',
    inputPath,
    // Only the audio. Downloads can carry cover art, which would otherwise come along as a video stream. This also
    // makes a file with no audio (an HTML error page saved as .mp3) fail instead of producing an empty output.
    '-map',
    '0:a:0',
    '-map_metadata',
    '-1',
    ...(audioFilter ? ['-filter:a', audioFilter] : []),
    '-ar',
    '44100',
    '-ac',
    '2',
    ...ffmpegOutputArgs(streamTo),
    '-y',
    outputPath,
  ];

  try {
    await runFfmpeg(args);
  } catch (err) {
    await fs.promises.rm(outputPath, { force: true });
    throw err;
  }
}
