import { createMachine, assign } from 'xstate';
import type { IAudioMetadata } from 'music-metadata';

export interface SongContext {
  id?: string;
  title?: string;
  artist?: string;
  url?: string;
  metadata?: IAudioMetadata;
}

export type SongEvent =
  | { type: 'FETCH_FINISH'; songId: string; title: string; artist: string; url: string }
  | { type: 'START_DOWNLOAD' }
  | { type: 'FINISH_DOWNLOAD' }
  | { type: 'SKIP_DOWNLOAD' }
  | { type: 'START_TRANSCODE' }
  | { type: 'FINISH_TRANSCODE' }
  | { type: 'SKIP_TRANSCODE' }
  | { type: 'START_ANNOUNCER_DL_AND_TRANSCODE' }
  | { type: 'FINISH_ANNOUNCER_DL_AND_TRANSCODE' }
  | { type: 'UPDATE_METADATA'; metadata: IAudioMetadata };

export const songMachine = createMachine({
  types: {} as { context: SongContext; events: SongEvent },
  initial: 'init',
  context: {},
  states: {
    init: {
      on: {
        FETCH_FINISH: {
          target: 'fetched',
          actions: assign(({ event }) => ({
            id: event.songId,
            title: event.title,
            artist: event.artist,
            url: event.url,
          })),
        },
      },
    },
    fetched: {
      on: {
        START_DOWNLOAD: 'downloading',
        SKIP_DOWNLOAD: 'downloaded',
        SKIP_TRANSCODE: 'transcoded',
      },
    },
    downloading: {
      on: { FINISH_DOWNLOAD: 'downloaded' },
    },
    downloaded: {
      on: { START_TRANSCODE: 'transcoding' },
    },
    transcoding: {
      on: { FINISH_TRANSCODE: 'transcoded' },
    },
    transcoded: {
      on: {
        START_ANNOUNCER_DL_AND_TRANSCODE: 'announcerProcessing',
        UPDATE_METADATA: {
          actions: assign(({ event }) => ({ metadata: event.metadata })),
        },
      },
    },
    announcerProcessing: {
      on: { FINISH_ANNOUNCER_DL_AND_TRANSCODE: 'ready' },
    },
    ready: {},
  },
});
