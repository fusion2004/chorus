const fs = require('fs');
const path = require('path');
const { interpret } = require('xstate');

const { songMachine } = require('./machines');
const { escapeDiscordMarkdown } = require('../utils/markdown');

const {
  announcerAws,
  announcerFinal,
  announcerIntermediate,
  downloadFinal,
  downloadIntermediate,
  transcodeFinal,
  transcodeIntermediate,
} = require('../utils/symbols');

async function fileExists(path) {
  try {
    await fs.promises.access(path, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function formatDuration(durationInSeconds) {
  let minutes = Math.floor(durationInSeconds / 60);
  let seconds = `${Math.floor(durationInSeconds % 60)}`;

  return `${minutes}:${seconds.padStart(2, '0')}`;
}

class Song {
  constructor(directory) {
    this.directory = directory;
    this.service = interpret(songMachine).onTransition((state) => {
      if (state.value === 'init') {
        return;
      }

      console.log(`[Song->${state.value}](${state.event.type}) Song #${this.id} - ${this.title}`);
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

  get formattedDuration() {
    let { metadata } = this.service.state.context;

    if (metadata?.format?.duration) {
      return formatDuration(metadata.format.duration);
    } else {
      return null;
    }
  }

  path(type) {
    switch (type) {
      case announcerAws:
      case announcerFinal:
      case announcerIntermediate:
        return path.join(this.directory, 'announcer', this.filename(type));
      case downloadFinal:
      case downloadIntermediate:
        return path.join(this.directory, 'download', this.filename(type));
      case transcodeFinal:
      case transcodeIntermediate:
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
      case downloadFinal:
        return `${this.id}-download.mp3`;
      case downloadIntermediate:
        return `${this.id}-download-intermediate.mp3`;
      case transcodeFinal:
        return `${this.id}-transcode.mp3`;
      case transcodeIntermediate:
        return `${this.id}-transcode-intermediate.mp3`;
    }
  }

  // If we have any final files from the stages of processing, we can likely
  // skip some states of processing!
  async transitionIfProcessed() {
    let response = { id: this.id };
    let finalDownloadExists = await fileExists(this.path(downloadFinal));
    let finalTranscodeExists = await fileExists(this.path(transcodeFinal));

    // We're not going to skip generating the announcer, even if we have the
    // final mp3, because the title may have changed.
    if (finalTranscodeExists) {
      this.service.send('SKIP_TRANSCODE');
      response.action = 'SKIP_TRANSCODE';
    } else if (finalDownloadExists) {
      this.service.send('SKIP_DOWNLOAD');
      response.action = 'SKIP_DOWNLOAD';
    } else {
      response.action = false;
    }

    return response;
  }
}

module.exports = Song;
