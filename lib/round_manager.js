const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const CompoThaSauceFetcher = require('./compo_thasauce_fetcher');
const { metadataUpdater } = require('./machines');
const { transcodeFinal } = require('../utils/symbols');

class RoundManager {
  constructor(roundId) {
    let parentDir = `${path.dirname(__dirname)}/tmp/rounds/${roundId}`;
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId, parentDir);
    this.songs = null;
    this.currentSong = null;

    this.dirs = {
      parent: parentDir,
      download: `${parentDir}/download`,
      transcode: `${parentDir}/transcode`,
      announcer: `${parentDir}/announcer`
    };

    this._makeDirectories();
  }

  nextSong() {
    if (this.currentSong) {
      let currentSongIndex = this.songs.indexOf(this.currentSong);
      this.currentSong = this.songs[currentSongIndex + 1];
    } else {
      [this.currentSong] = this.songs;
    }

    return this.currentSong;
  }

  async getAllSongs() {
    if (this.songs) {
      return this.songs;
    }

    let songs = await this.fetcher.fetch();
    this.songs = songs;
  }

  async transitionProcessedSongs() {
    await Promise.all(this.songs.map((song) => song.transitionIfProcessed()));
  }

  async parseMetadata() {
    let promises = this.songs.map(async(song) => {
      let metadata = await mm.parseFile(song.path(transcodeFinal));
      song.service.send(metadataUpdater.update(metadata));
    });

    await Promise.all(promises);
  }

  _makeDirectories() {
    let dirs = [this.dirs.parent, this.dirs.download, this.dirs.transcode, this.dirs.announcer];
    dirs.forEach((dir) => {
      this._makeDirectoryIfItDoesntExist(dir);
    });
  }

  _makeDirectoryIfItDoesntExist(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }
}

module.exports = RoundManager;
