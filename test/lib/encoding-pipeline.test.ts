// End-to-end tests for every place we push audio through ffmpeg: song
// transcoding, per-song announcers, and the extra (outro) announcer.
//
// These run the real ffmpeg binary and verify the output with ffprobe, so they
// only care about the contract — "this input file becomes a correctly encoded
// output file at this path" — not how we spawn or stream to ffmpeg. That's
// intentional: a Node upgrade (v26's Readable fast path) once broke
// prism-media's FFmpeg Duplex, which piped audio through ffmpeg's stdin, in a
// way no unit test noticed.
//
// Fixture size matters. The Node 26 breakage only showed up once ffmpeg's
// stdin applied backpressure and the source stream resumed — a ~180KB input
// sailed through, a ~1.8MB one failed every time. Fixtures here are sized well
// past that, so any streaming wiring gets exercised under backpressure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoundAnnouncer } from '@src/lib/round-announcer.js';
import { RoundExtraAnnouncer } from '@src/lib/round-extra-announcer.js';
import { RoundTranscoder } from '@src/lib/round-transcoder.js';
import { Song } from '@src/lib/song.js';
import type { StreamingMode } from '@src/lib/streaming/types.js';
import { synthesizeToFile } from '@src/lib/polly.js';
import {
  announcerAws,
  announcerFinal,
  announcerIntermediate,
  downloadFinal,
  transcodeFinal,
  transcodeIntermediate,
} from '@src/utils/symbols.js';
import { fileExists, probe, writeSineMp3 } from '@test/helpers/audio.js';

vi.mock('@src/lib/polly.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/lib/polly.js')>()),
  synthesizeToFile: vi.fn(),
}));

const SONG_SECONDS = 60;
const ANNOUNCER_SECONDS = 60;
const DURATION_TOLERANCE = 0.3;

const EXPECTED: Record<StreamingMode, { formatName: string; codecName: string }> = {
  icecast: { formatName: 'mp3', codecName: 'mp3' },
  mux: { formatName: 'mpegts', codecName: 'aac' },
};

const MODES = Object.keys(EXPECTED) as StreamingMode[];

let fixturesDir: string;
let songFixture: string;
let pollyFixture: string;
let workDir: string;

beforeAll(async () => {
  fixturesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chorus-fixtures-'));
  songFixture = path.join(fixturesDir, 'song.mp3');
  pollyFixture = path.join(fixturesDir, 'polly.mp3');

  // A 48kHz mono source, so the 44.1kHz stereo output proves a real re-encode.
  await writeSineMp3(songFixture, {
    seconds: SONG_SECONDS,
    sampleRate: 48000,
    channels: 1,
    bitrate: '320k',
  });
  // Shaped like Polly's output: 24kHz mono MP3 (160k is MPEG-2 Layer III's max).
  await writeSineMp3(pollyFixture, {
    seconds: ANNOUNCER_SECONDS,
    sampleRate: 24000,
    channels: 1,
    bitrate: '160k',
  });

  expect(fs.statSync(songFixture).size).toBeGreaterThan(2 * 1024 * 1024);
  expect(fs.statSync(pollyFixture).size).toBeGreaterThan(1024 * 1024);
});

afterAll(async () => {
  await fs.promises.rm(fixturesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chorus-encode-'));
  for (const sub of ['download', 'transcode', 'announcer']) {
    await fs.promises.mkdir(path.join(workDir, sub));
  }

  vi.mocked(synthesizeToFile).mockReset();
  vi.mocked(synthesizeToFile).mockImplementation(async (_ssml, outputPath) => {
    await fs.promises.copyFile(pollyFixture, outputPath);
  });

  return async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  };
});

function downloadedSong(id: string, streamTo: StreamingMode): Song {
  const song = new Song(workDir, streamTo);
  song.service.send({
    type: 'FETCH_FINISH',
    songId: id,
    title: `Song ${id}`,
    artist: 'Test Artist',
    url: `https://example.com/${id}.mp3`,
  });
  song.service.send({ type: 'START_DOWNLOAD' });
  song.service.send({ type: 'FINISH_DOWNLOAD' });
  fs.copyFileSync(songFixture, song.path(downloadFinal));
  return song;
}

function transcodedSong(id: string, streamTo: StreamingMode): Song {
  const song = downloadedSong(id, streamTo);
  song.service.send({ type: 'START_TRANSCODE' });
  song.service.send({ type: 'FINISH_TRANSCODE' });
  return song;
}

async function expectEncoded(
  filePath: string,
  streamTo: StreamingMode,
  expectedSeconds: number,
): Promise<void> {
  const info = await probe(filePath);
  expect(info).toMatchObject({ ...EXPECTED[streamTo], sampleRate: 44100, channels: 2 });
  expect(info.duration).toBeGreaterThan(expectedSeconds - DURATION_TOLERANCE);
  expect(info.duration).toBeLessThan(expectedSeconds + DURATION_TOLERANCE);
}

// The announcers run production's loudnorm filter over a minute of audio, which
// takes a couple of seconds locally — leave headroom for slower CI runners.
describe.each(MODES)('encoding pipeline (%s)', { timeout: 30_000 }, (streamTo) => {
  describe('RoundTranscoder', () => {
    it('transcodes every downloaded song to the backend format', async () => {
      // Three songs matches the transcoder's concurrency limit, so all three
      // ffmpeg processes run at once like they do in a real party.
      const songs = ['s1', 's2', 's3'].map((id) => downloadedSong(id, streamTo));

      await new RoundTranscoder(streamTo).transcode(songs);

      for (const song of songs) {
        expect(song.service.getSnapshot().value).toBe('transcoded');
        expect(song.path(transcodeFinal).endsWith(streamTo === 'mux' ? '.ts' : '.mp3')).toBe(true);
        expect(fileExists(song.path(transcodeIntermediate))).toBe(false);
        await expectEncoded(song.path(transcodeFinal), streamTo, SONG_SECONDS);
      }
    });

    // The realistic bad download: an HTML error page saved as .mp3. With
    // prism-media this became an empty "transcoded" file and the party carried
    // on, because prism ignored ffmpeg's exit status. It's small on purpose:
    // when audio was piped through ffmpeg's stdin, multi-MB garbage happened to
    // reject anyway (EPIPE), but a small file was fully written before ffmpeg
    // gave up.
    it('rejects when the download is not audio', async () => {
      const song = downloadedSong('bad', streamTo);
      await fs.promises.writeFile(
        song.path(downloadFinal),
        '<!doctype html><html><body><h1>404 Not Found</h1></body></html>\n',
      );

      await expect(new RoundTranscoder(streamTo).transcodeSong(song)).rejects.toThrow();
      expect(fileExists(song.path(transcodeFinal))).toBe(false);
      expect(fileExists(song.path(transcodeIntermediate))).toBe(false);
    });
  });

  describe('RoundAnnouncer', () => {
    it('encodes the Polly output for each song and cleans up the raw file', async () => {
      const songs = ['s1', 's2'].map((id) => transcodedSong(id, streamTo));

      await new RoundAnnouncer('Test Round', streamTo).process(songs);

      expect(synthesizeToFile).toHaveBeenCalledTimes(2);
      for (const song of songs) {
        expect(song.service.getSnapshot().value).toBe('ready');
        expect(fileExists(song.path(announcerAws))).toBe(false);
        expect(fileExists(song.path(announcerIntermediate))).toBe(false);
        await expectEncoded(song.path(announcerFinal), streamTo, ANNOUNCER_SECONDS);
      }
    });
  });

  describe('RoundExtraAnnouncer', () => {
    it('encodes the outro announcer and returns its path', async () => {
      const announcers = await new RoundExtraAnnouncer('Test Round', streamTo).process(workDir);

      expect(announcers.map((a) => a.id)).toEqual(['outro']);
      const [outro] = announcers;
      expect(outro.path).toBe(path.join(workDir, `outro.${streamTo === 'mux' ? 'ts' : 'mp3'}`));
      expect(fileExists(path.join(workDir, 'outro-aws.mp3'))).toBe(false);
      await expectEncoded(outro.path!, streamTo, ANNOUNCER_SECONDS);
    });
  });
});
