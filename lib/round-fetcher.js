const fs = require('fs');
const { pipeline } = require('stream/promises');

const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const got = require('got');

const { log } = require('./logger');
const { downloadFinal, downloadIntermediate } = require('../utils/symbols');

class RoundFetcher {
  async fetch(songs) {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333,
    });

    let songsToFetch = songs.filter((song) => song.service.state.matches('fetched'));

    let downloadPromises = songsToFetch.map((song) => {
      return limiter.schedule(() => this.fetchSong(song));
    });

    await Promise.all(downloadPromises);
  }

  async fetchSong(song) {
    let downloadPath = song.path(downloadIntermediate);
    let finalPath = song.path(downloadFinal);
    let writeStream = fs.createWriteStream(downloadPath);
    let requestStream = got.stream(song.url);

    song.service.send('START_DOWNLOAD');

    await pipeline(requestStream, writeStream);

    await fs.promises.rename(downloadPath, finalPath);

    song.service.send('FINISH_DOWNLOAD');
  }
}

module.exports = RoundFetcher;
