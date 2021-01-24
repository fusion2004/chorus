const fs = require('fs');
const path = require('path');
const { interpret } = require('xstate');

const { songMachine } = require('./machines');
const { escapeDiscordMarkdown } = require('../utils/markdown');

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

async function fileExists(path) {
  try {
    await fs.promises.access(path, fs.constants.F_OK);
    return true;
  } catch(e) {
    return false;
  }
}

class Song {
  constructor(directory) {
    this.directory = directory;
    this.service = interpret(songMachine).onTransition((state) => {
      if (state.value === 'init') {
        return;
      }

      let statement = `[Song->${state.value}](${state.event.type}) Song #${this.id} - ${this.title}`;
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

  // Returns a title that has any discord formatting markdown escaped
  get safeTitle() {
    return escapeDiscordMarkdown(this.title);
  }

  get artist() {
    return this.service.state.context.artist;
  }

  // Returns an artist that has any discord formatting markdown escaped
  get safeArtist() {
    return escapeDiscordMarkdown(this.artist);
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

  // If we have any final files from the stages of processing, we can likely
  // skip some states of processing!
  async transitionIfProcessed() {
    let finalDownloadExists = await fileExists(this.path(downloadFinal));
    let finalTranscodeExists = await fileExists(this.path(transcodeFinal));

    // We're not going to skip generating the announcer, even if we have the
    // final mp3, because the title may have changed.
    if (finalTranscodeExists) {
      this.service.send('SKIP_TRANSCODE');
    } else if (finalDownloadExists) {
      this.service.send('SKIP_DOWNLOAD');
    }
  }
}

module.exports = Song;
