const { createMachine } = require('xstate');
const { assign, createUpdater } = require('@xstate/immer');

let metadataUpdater = createUpdater('UPDATE_METADATA', (context, { input }) => context.metadata = input);

let songMachine = createMachine({
  initial: 'init',
  context: {},
  states: {
    init: {
      on: {
        FETCH_FINISH: {
          target: 'fetched',
          actions: ['storeFetchedData']
        }
      }
    },
    fetched: {
      on: {
        START_DOWNLOAD: 'downloading',
        SKIP_DOWNLOAD: 'downloaded',
        SKIP_TRANSCODE: 'transcoded'
      }
    },
    downloading: {
      on: {
        FINISH_DOWNLOAD: 'downloaded'
      }
    },
    downloaded: {
      on: {
        START_TRANSCODE: 'transcoding'
      }
    },
    transcoding: {
      on: {
        FINISH_TRANSCODE: {
          target: 'transcoded'
        }
      }
    },
    transcoded: {
      on: {
        START_ANNOUNCER_DL_AND_TRANSCODE: 'announcerProcessing',
        [metadataUpdater.type]: { actions: metadataUpdater.action }
      }
    },
    announcerProcessing: {
      on: {
        FINISH_ANNOUNCER_DL_AND_TRANSCODE: 'ready'
      }
    },
    ready: {}
  }
}, {
  actions: {
    storeFetchedData: assign((context, event) => {
      context.id = event.songId;
      context.title = event.title;
      context.artist = event.artist;
      context.url = event.url;
    })
  }
});

module.exports = {
  songMachine,
  metadataUpdater
};
