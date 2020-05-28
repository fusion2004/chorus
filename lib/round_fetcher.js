const fs = require('fs');
const { pipeline } = require('stream');
const needle = require('needle');
const Promise = require('bluebird');

class RoundFetcher {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async fetch() {
    let downloadPromises = this.roundManager.songs.map((song) => {
      return new Promise((resolve, reject) => {
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
        let rejected = false;
        let handleError = (err, msg) => {
          if (rejected) {
            return;
          }
          console.error(msg.error);
          reject(err);
          rejected = true;
        };

        requestStream.on('timeout', (err) => handleError(err, `FETCH[TIMEOUT]: Downloading ${song.id} from ${song.url} to ${downloadPath}`));
        requestStream.on('err', (err) => handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`));

        pipeline(
          requestStream,
          writeStream,
          (err) => {
            if (err) {
              handleError(err, `FETCH[ERROR]: Downloading ${song.id} from ${song.url} to ${downloadPath}`);
            } else if (!rejected) {
              console.info(`FETCH[FINISH]: Downloaded to ${downloadPath}`.success);
              song.paths.download = downloadPath;
              resolve();
            }
          }
        );
      });
    });

    await Promise.all(downloadPromises);
  }
}

module.exports = RoundFetcher;
