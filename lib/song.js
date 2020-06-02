const path = require('path');
const { createMachine, interpret } = require('xstate');
const { assign } = require('@xstate/immer');

const {
  announcerAws,
  announcerFinal,
  announcerIntermediate,
  announcerPcm,
  downloadFinal,
  downloadIntermediate,
  transcodeFinal,
  transcodeIntermediate,
  transcodePcm
} = require('../utils/symbols');

let successStates = [
  'fetched',
  'downloaded',
  'transcoded',
  'ready'
];

// TODO: allow transitioning from fetched directly into a later state if we have
// the requisite final file for download, transcode, or announcer
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
        START_DOWNLOAD: 'downloading'
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
          target: 'transcoded',
          actions: ['storeMetadata']
        }
      }
    },
    transcoded: {
      on: {
        START_ANNOUNCER_DL_AND_TRANSCODE: 'announcerProcessing'
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
    }),
    storeMetadata: assign((context, event) => context.metadata = event.metadata)
  }
});

class Song {
  constructor(directory) {
    this.directory = directory;
    this.service = interpret(songMachine).onTransition((state) => {
      if (state.value === 'init') {
        return;
      }

      let statement = `[Song->${state.value}] Song #${this.id}`;
      if (successStates.includes(state.value)) {
        statement = statement.success;
      } else {
        statement = statement.info;
      }

      console.info(statement);
    });
    this.service.start();
  }

  get id() {
    return this.service.state.context.id;
  }

  get title() {
    return this.service.state.context.title;
  }

  get artist() {
    return this.service.state.context.artist;
  }

  get url() {
    return this.service.state.context.url;
  }

  get metadata() {
    return this.service.state.context.metadata;
  }

  path(type) {
    switch (type) {
      case announcerAws:
      case announcerFinal:
      case announcerIntermediate:
      case announcerPcm:
        return path.join(this.directory, 'announcer', this.filename(type));
      case downloadFinal:
      case downloadIntermediate:
        return path.join(this.directory, 'download', this.filename(type));
      case transcodeFinal:
      case transcodeIntermediate:
      case transcodePcm:
        return path.join(this.directory, 'transcode', this.filename(type));
    }
  }

  filename(type) {
    switch (type) {
      case announcerAws:
        return `${this.id}-announcer-aws.mp3`;
      case announcerFinal:
        return `${this.id}-announcer.mp3`;
      case announcerIntermediate:
        return `${this.id}-announcer-intermediate.mp3`;
      case announcerPcm:
        return `${this.id}-announcer-pcm.pcm`;
      case downloadFinal:
        return `${this.id}-download.mp3`;
      case downloadIntermediate:
        return `${this.id}-download-intermediate.mp3`;
      case transcodeFinal:
        return `${this.id}-transcode.mp3`;
      case transcodeIntermediate:
        return `${this.id}-transcode-intermediate.mp3`;
      case transcodePcm:
        return `${this.id}-transcode-pcm.pcm`;
    }
  }
}

module.exports = Song;
