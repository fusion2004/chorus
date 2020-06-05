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

/**
 * Reconciles the existing songs with newly fetched songs, leaving in place any
 * existing songs that still exist, so we maintain those songs' state machines
 * and processing.
 *
 * @param {Array} existingSongs - An array of existing songs
 * @param {Array} newSongs - An array of newly fetched songs
 * @returns {Array}
 */
function reconcileSongs(existingSongs, newSongs) {
  let left = zippa.ArrayZipper.from(existingSongs).next();
  let right = zippa.ArrayZipper.from(newSongs).next();

  while (!left.isEnd() || !right.isEnd()) {
    // If we reached the end of existing songs, but not the new songs, we want
    // to append the new song to the existing song.
    if (left.isEnd()) {
      // There doesn't seem to be a way to recover from reaching the END of a
      // zippa, so we'll construct the changes and make a new one!
      left = zippa.ArrayZipper.from(left.value());

      // If the left isn't empty...
      if (left.down()) {
        // We'll go into the array, all the way over to the right, and insert
        // our new entry.
        left = left.down().rightmost().insertRight(right.value());
      } else {
        // Otherwise, we'll make a new zippa using an array of the new entry.
        left = zippa.ArrayZipper.from([right.value()]);
      }
      // Finally, we'll get the zippa back to the END. (By going right once, to
      // get to the newly inserted value, and then again to reach the END.)
      left = left.next().next();
      right = right.next();

    // If we reached the end of the new songs, but not the existing songs, it
    // means there are extra songs in the existing songs that don't exist
    // anymore. Thus, we'll remove the current existing song.
    } else if (right.isEnd()) {
      left = left.remove().next();

    // If we're looking at the same song in both, do nothing!
    } else if (left.item.id === right.item.id) {
      left = left.next();
      right = right.next();

    // If the current existing song occurs later in the new songs, we should
    // insert the current new song to the left of the current existing song.
    } else if (songExistsInArray(left.value(), right.path.right)) {
      left = left.insertLeft(right.value());
      right = right.next();

    // Otherwise, the current existing song no longer exists, so we should
    // remove it.
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
