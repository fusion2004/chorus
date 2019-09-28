const fs = require('fs');
const request = require('request');
const Promise = require('bluebird');

class RoundFetcher {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async fetch() {
    let downloadPromises = this.roundManager.songs.map((song) => {
      return new Promise((resolve) => {
        let downloadPath = `${this.roundManager.dirs.download}/${song.filename()}`;
        let writeStream = fs.createWriteStream(downloadPath);
        let requestStream = request(song.url);

        let pipe = requestStream.pipe(writeStream);

        pipe.on('finish', () => {
          song.paths.download = downloadPath;
          resolve();
        });
      });
    });

    await Promise.all(downloadPromises);
  }
}

module.exports = RoundFetcher;
