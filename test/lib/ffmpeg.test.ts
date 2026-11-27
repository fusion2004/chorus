// Tests for src/lib/ffmpeg.ts against the real ffmpeg/ffprobe on PATH. The encoding pipeline tests cover encodeAudio
// end to end; these cover probeDuration and the error messages that end up in the debug channel.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeAudio, FfmpegError, probeDuration } from '@src/lib/ffmpeg.js';
import type { StreamingMode } from '@src/lib/streaming/types.js';
import { fileExists, writeSineMp3 } from '@test/helpers/audio.js';

const SECONDS = 10;
const NOT_AUDIO = '<!doctype html><html><body><h1>404 Not Found</h1></body></html>\n';

let dir: string;
let mp3: string;
let notAudio: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chorus-ffmpeg-'));
  mp3 = path.join(dir, 'tone.mp3');
  notAudio = path.join(dir, 'not-audio.mp3');
  await writeSineMp3(mp3, { seconds: SECONDS, sampleRate: 48000, channels: 1, bitrate: '128k' });
  await fs.promises.writeFile(notAudio, NOT_AUDIO);
});

afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('probeDuration', () => {
  it('reads the duration of an MP3', async () => {
    expect(await probeDuration(mp3)).toBeCloseTo(SECONDS, 1);
  });

  // The Mux backend plays MPEG-TS files, which music-metadata couldn't read.
  it.each<StreamingMode>(['icecast', 'mux'])(
    'reads the duration of %s output',
    async (streamTo) => {
      const output = path.join(dir, `encoded-${streamTo}`);
      await encodeAudio(mp3, output, streamTo);

      expect(Math.abs((await probeDuration(output)) - SECONDS)).toBeLessThan(0.3);
    },
  );

  it('rejects with ffprobe’s reason when the file is not audio', async () => {
    await expect(probeDuration(notAudio)).rejects.toThrow(
      /ffprobe exited with code \d+: .*Invalid data/s,
    );
  });

  it('rejects when the file does not exist', async () => {
    await expect(probeDuration(path.join(dir, 'missing.mp3'))).rejects.toThrow(FfmpegError);
  });
});

describe('encodeAudio', () => {
  it('rejects with ffmpeg’s reason and leaves no output when the input is not audio', async () => {
    const output = path.join(dir, 'bad.mp3');

    await expect(encodeAudio(notAudio, output, 'icecast')).rejects.toThrow(
      /ffmpeg exited with code \d+: .*Invalid data/s,
    );
    expect(fileExists(output)).toBe(false);
  });
});
