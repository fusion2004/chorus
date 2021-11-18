const fs = require('fs');
const stream = require('stream');
const util = require('util');

const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const needle = require('needle');

const { log } = require('./logger');
const { downloadFinal, downloadIntermediate } = require('../utils/symbols');

const pipeline = util.promisify(stream.pipeline);

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
    let requestStream = needle.get(song.url, {
      // ._. why snakecase, needle? why?
      // eslint-disable-next-line camelcase
      response_timeout: 30000,
      // eslint-disable-next-line camelcase
      read_timeout: 30000,
    });

    song.service.send('START_DOWNLOAD');

    // I hate that I have to do this.
    // I seem to be getting inconsistent emitted errors below, so I want to make sure we only ever report
    // and reject the promise on the first one.
    // Next, I should try using node-fetch and see if it is more consistent so we can drop this.
    let handleError = (err, msg) => {
      log(msg, 'error');
      if (err instanceof Error) {
        throw err;
      } else {
        // If it's not an error instance, assume it is a string we should wrap with an Error
        throw new Error(err);
      }
    };

    requestStream.on('timeout', (err) =>
      handleError(err, `FETCH[TIMEOUT]: Downloading ${song.id} from ${song.url} to ${downloadPath}`)
    );
    requestStream.on('err', (err) =>
      handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`)
    );

    await pipeline(requestStream, writeStream).catch((err) => {
      handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`);
    });

    await fs.promises.rename(downloadPath, finalPath);

    song.service.send('FINISH_DOWNLOAD');
  }
}

module.exports = RoundFetcher;
