const fs = require('fs');
const stream = require('stream');
const util = require('util');

const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const needle = require('needle');

const pipeline = util.promisify(stream.pipeline);

class RoundFetcher {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async fetch() {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333
    });

    let downloadPromises = this.roundManager.songs.map((song) => {
      return limiter.schedule(() => this.fetchSong(song));
    });

    await Promise.all(downloadPromises);
  }

  async fetchSong(song) {
    let downloadPath = `${this.roundManager.dirs.download}/${song.filename()}`;
    let writeStream = fs.createWriteStream(downloadPath);
    let requestStream = needle.get(song.url, {
      // ._. why snakecase, needle? why?
      // eslint-disable-next-line camelcase
      response_timeout: 30000,
      // eslint-disable-next-line camelcase
      read_timeout: 30000
    });

    console.info(`FETCH[START]: Downloading ${song.id} to ${downloadPath}`.info);

    // I hate that I have to do this.
    // I seem to be getting inconsistent emitted errors below, so I want to make sure we only ever report
    // and reject the promise on the first one.
    // Next, I should try using node-fetch and see if it is more consistent so we can drop this.
    let handleError = (err, msg) => {
      console.error(msg.error);
      if (err instanceof Error) {
        throw err;
      } else {
        // If it's not an error instance, assume it is a string we should wrap with an Error
        throw new Error(err);
      }
    };

    // throw new Error('test fetch error');

    requestStream.on('timeout', (err) => handleError(err, `FETCH[TIMEOUT]: Downloading ${song.id} from ${song.url} to ${downloadPath}`));
    requestStream.on('err', (err) => handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`));

    await pipeline(requestStream, writeStream).catch((err) => {
      handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`);
    });

    console.info(`FETCH[FINISH]: Downloaded to ${downloadPath}`.success);
    // eslint-disable-next-line require-atomic-updates
    song.paths.download = downloadPath;
  }
}

module.exports = RoundFetcher;
