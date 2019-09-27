const path = require('path');
const fs = require('fs');
const request = require('request');
const Promise = require('bluebird');

class RoundFetcher {
  constructor(roundManager) {
    this.roundManager = roundManager;

    this.parentDir = `${path.dirname(__dirname)}/tmp/rounds/${this.roundManager.roundId}`;
    this.retrievedDir = `${this.parentDir}/retrieved`;
    this.tmpDir = `${this.parentDir}/tmp`;
  }

  async fetch() {
    this._makeDirectories();

    let downloadPromises = this.roundManager.songs.map((song) => {
      return new Promise((resolve) => {
        let temppath = `${this.tmpDir}/${song.filename()}`;
        let finalpath = `${this.retrievedDir}/${song.filename()}`;
        let writestream = fs.createWriteStream(temppath);
        let requeststream = request(song.url);

        let pipe = requeststream.pipe(writestream);

        pipe.on('finish', () => {
          fs.rename(temppath, finalpath, () => {
            song.filepath = finalpath;
            resolve();
          });
        });
      });
    });

    await Promise.all(downloadPromises);
  }

  _makeDirectories() {
    [this.parentDir, this.retrievedDir, this.tmpDir].forEach((dir) => {
      this._makeDirectoryIfItDoesntExist(dir);
    });
  }

  _makeDirectoryIfItDoesntExist(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }

}

module.exports = RoundFetcher;
