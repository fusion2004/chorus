import { createMachine, assign } from 'xstate';

export interface SongContext {
  id?: string;
  title?: string;
  artist?: string;
  url?: string;
  /** Seconds, probed from the transcoded file. */
  duration?: number;
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
  | { type: 'UPDATE_DURATION'; duration: number };

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
        UPDATE_DURATION: {
          actions: assign(({ event }) => ({ duration: event.duration })),
        },
      },
    },
    announcerProcessing: {
      on: { FINISH_ANNOUNCER_DL_AND_TRANSCODE: 'ready' },
    },
    ready: {},
  },
});
