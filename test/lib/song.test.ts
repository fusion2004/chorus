import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Song, formatDuration } from '../../src/lib/song.js';
import {
  announcerAws,
  announcerFinal,
  announcerIntermediate,
  downloadFinal,
  downloadIntermediate,
  transcodeFinal,
  transcodeIntermediate,
} from '../../src/utils/symbols.js';

function fetchSong(
  song: Song,
  overrides: Partial<{ id: string; title: string; artist: string; url: string }> = {},
): Song {
  song.service.send({
    type: 'FETCH_FINISH',
    songId: overrides.id ?? 's1',
    title: overrides.title ?? 'My Song',
    artist: overrides.artist ?? 'Some Artist',
    url: overrides.url ?? 'https://example.com/s1.mp3',
  });
  return song;
}

describe('formatDuration', () => {
  it('formats seconds to M:SS', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(65.8)).toBe('1:05');
  });
});

describe('Song', () => {
  it('getters reflect context after FETCH_FINISH', () => {
    const song = fetchSong(new Song('/tmp/x'), { id: 'abc', title: 'T', artist: 'A', url: 'U' });
    expect(song.id).toBe('abc');
    expect(song.title).toBe('T');
    expect(song.artist).toBe('A');
    expect(song.url).toBe('U');
  });

  it('safeTitle and safeArtist escape Discord markdown', () => {
    const song = fetchSong(new Song('/tmp/x'), { title: 'hey *there*', artist: '_cool_guy_' });
    expect(song.safeTitle).toBe('hey \\*there\\*');
    expect(song.safeArtist).toBe('\\_cool\\_guy\\_');
  });

  it('safeTitle and safeArtist return empty string before title/artist are set', () => {
    const song = new Song('/tmp/x');
    expect(song.safeTitle).toBe('');
    expect(song.safeArtist).toBe('');
  });

  it('formattedDuration returns null when no metadata is set', () => {
    const song = fetchSong(new Song('/tmp/x'));
    expect(song.formattedDuration).toBeNull();
  });

  it('formattedDuration returns M:SS when metadata has a duration', () => {
    const song = fetchSong(new Song('/tmp/x'));
    song.service.send({ type: 'SKIP_TRANSCODE' });
    song.service.send({
      type: 'UPDATE_METADATA',
      metadata: { format: { duration: 185 } } as any,
    });
    expect(song.formattedDuration).toBe('3:05');
  });

  describe('filename', () => {
    let song: Song;
    beforeEach(() => {
      song = fetchSong(new Song('/base'), { id: '42' });
    });

    it('returns names for each announcer symbol', () => {
      expect(song.filename(announcerAws)).toBe('42-announcer-aws.mp3');
      expect(song.filename(announcerFinal)).toBe('42-announcer.mp3');
      expect(song.filename(announcerIntermediate)).toBe('42-announcer-intermediate.mp3');
    });

    it('returns names for each download symbol', () => {
      expect(song.filename(downloadFinal)).toBe('42-download.mp3');
      expect(song.filename(downloadIntermediate)).toBe('42-download-intermediate.mp3');
    });

    it('returns names for each transcode symbol', () => {
      expect(song.filename(transcodeFinal)).toBe('42-transcode.mp3');
      expect(song.filename(transcodeIntermediate)).toBe('42-transcode-intermediate.mp3');
    });

    it('throws on unknown symbol', () => {
      expect(() => song.filename(Symbol('nope'))).toThrow('Unknown file type symbol');
    });
  });

  describe('path', () => {
    it('joins directory, category subfolder, and filename', () => {
      const song = fetchSong(new Song('/base'), { id: '42' });
      expect(song.path(downloadFinal)).toBe(path.join('/base', 'download', '42-download.mp3'));
      expect(song.path(transcodeIntermediate)).toBe(
        path.join('/base', 'transcode', '42-transcode-intermediate.mp3'),
      );
      expect(song.path(announcerAws)).toBe(path.join('/base', 'announcer', '42-announcer-aws.mp3'));
    });

    it('throws on unknown symbol', () => {
      const song = fetchSong(new Song('/base'), { id: '42' });
      expect(() => song.path(Symbol('nope'))).toThrow('Unknown file type symbol');
    });
  });

  describe('transitionIfProcessed', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chorus-song-test-'));
      await fs.promises.mkdir(path.join(tmpDir, 'download'));
      await fs.promises.mkdir(path.join(tmpDir, 'transcode'));
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns action=false when no final files exist', async () => {
      const song = fetchSong(new Song(tmpDir), { id: 'no-files' });
      const result = await song.transitionIfProcessed();
      expect(result.action).toBe(false);
      expect(result.id).toBe('no-files');
      expect(song.service.getSnapshot().value).toBe('fetched');
    });

    it('sends SKIP_DOWNLOAD when only final download exists', async () => {
      const song = fetchSong(new Song(tmpDir), { id: 'dl' });
      await fs.promises.writeFile(song.path(downloadFinal), 'stub');
      const result = await song.transitionIfProcessed();
      expect(result.action).toBe('SKIP_DOWNLOAD');
      expect(song.service.getSnapshot().value).toBe('downloaded');
    });

    it('sends SKIP_TRANSCODE when final transcode exists (takes precedence over download)', async () => {
      const song = fetchSong(new Song(tmpDir), { id: 'tr' });
      await fs.promises.writeFile(song.path(downloadFinal), 'stub');
      await fs.promises.writeFile(song.path(transcodeFinal), 'stub');
      const result = await song.transitionIfProcessed();
      expect(result.action).toBe('SKIP_TRANSCODE');
      expect(song.service.getSnapshot().value).toBe('transcoded');
    });
  });
});
