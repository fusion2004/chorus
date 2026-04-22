import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { songMachine } from './machines.js';

function start() {
  const actor = createActor(songMachine);
  actor.start();
  return actor;
}

describe('songMachine', () => {
  it('starts in init with empty context', () => {
    const actor = start();
    expect(actor.getSnapshot().value).toBe('init');
    expect(actor.getSnapshot().context).toEqual({});
  });

  it('FETCH_FINISH moves init → fetched and assigns id/title/artist/url', () => {
    const actor = start();
    actor.send({
      type: 'FETCH_FINISH',
      songId: 'song-1',
      title: 'Example',
      artist: 'Someone',
      url: 'https://example.com/song.mp3',
    });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe('fetched');
    expect(snap.context).toEqual({
      id: 'song-1',
      title: 'Example',
      artist: 'Someone',
      url: 'https://example.com/song.mp3',
    });
  });

  it('walks the happy path to ready', () => {
    const actor = start();
    actor.send({
      type: 'FETCH_FINISH',
      songId: 's',
      title: 't',
      artist: 'a',
      url: 'u',
    });
    actor.send({ type: 'START_DOWNLOAD' });
    expect(actor.getSnapshot().value).toBe('downloading');
    actor.send({ type: 'FINISH_DOWNLOAD' });
    expect(actor.getSnapshot().value).toBe('downloaded');
    actor.send({ type: 'START_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('transcoding');
    actor.send({ type: 'FINISH_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('transcoded');
    actor.send({ type: 'START_ANNOUNCER_DL_AND_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('announcerProcessing');
    actor.send({ type: 'FINISH_ANNOUNCER_DL_AND_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('ready');
  });

  it('SKIP_DOWNLOAD from fetched goes straight to downloaded', () => {
    const actor = start();
    actor.send({ type: 'FETCH_FINISH', songId: 's', title: 't', artist: 'a', url: 'u' });
    actor.send({ type: 'SKIP_DOWNLOAD' });
    expect(actor.getSnapshot().value).toBe('downloaded');
  });

  it('SKIP_TRANSCODE from fetched goes straight to transcoded', () => {
    const actor = start();
    actor.send({ type: 'FETCH_FINISH', songId: 's', title: 't', artist: 'a', url: 'u' });
    actor.send({ type: 'SKIP_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('transcoded');
  });

  it('UPDATE_METADATA in transcoded stays in transcoded and assigns metadata', () => {
    const actor = start();
    actor.send({ type: 'FETCH_FINISH', songId: 's', title: 't', artist: 'a', url: 'u' });
    actor.send({ type: 'SKIP_TRANSCODE' });
    const metadata = { format: { duration: 42 } } as any;
    actor.send({ type: 'UPDATE_METADATA', metadata });
    expect(actor.getSnapshot().value).toBe('transcoded');
    expect(actor.getSnapshot().context.metadata).toBe(metadata);
  });

  it('ignores irrelevant events in init', () => {
    const actor = start();
    actor.send({ type: 'FINISH_DOWNLOAD' });
    actor.send({ type: 'START_TRANSCODE' });
    expect(actor.getSnapshot().value).toBe('init');
  });
});
