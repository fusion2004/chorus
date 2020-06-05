const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const zippa = require('zippa');

const CompoThaSauceFetcher = require('./compo_thasauce_fetcher');
const { metadataUpdater } = require('./machines');
const { transcodeFinal } = require('../utils/symbols');

function songExistsInArray(song, array) {
  return array.some((item) => song.id === item.id);
}

function reconcileSongs(existingSongs, newSongs) {
  let left = zippa.ArrayZipper.from(existingSongs).next();
  let right = zippa.ArrayZipper.from(newSongs).next();

  while (!left.isEnd() || !right.isEnd()) {
    if (left.isEnd()) {
      // There doesn't seem to be a way to recover from reaching the END of a
      // zippa, so we'll construct the changes and make a new one!
      left = zippa.ArrayZipper.from(left.value());

      // If the left isn't empty...
      if (left.down()) {
        // We'll go into the array, all the way over to the right, and insert
        // our new entry.
        left = left.down().rightmost().insertRight(right.value());
        // Finally, we'll get the zippa back to the END. (By going right once, to
        // get to the newly inserted value, and then again to reach the END.)
        left = left.next().next();
      } else {
        // Otherwise, we'll make a new zippa using an array of the new entry.
        left = zippa.ArrayZipper.from([right.value()]);
        // And reach the END again (right once for the value, right again for end)
        left = left.next().next();
      }
      right = right.next();
    } else if (right.isEnd()) {
      left = left.remove().next();
    } else if (left.item.id === right.item.id) {
      left = left.next();
      right = right.next();
    } else if (songExistsInArray(left.value(), right.path.right)) {
      left = left.insertLeft(right.value());
      right = right.next();
    } else {
      left = left.remove().next();
    }
  }

  return left.value();
}

class RoundManager {
  constructor(roundId) {
    let parentDir = `${path.dirname(__dirname)}/tmp/rounds/${roundId}`;
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId, parentDir);
    this.songs = [];
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

  async fetchAndReconcileAllSongs() {
    let fetchedSongs = await this.fetcher.fetch();
    this.songs = reconcileSongs(this.songs, fetchedSongs);
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
