const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const zippa = require('zippa');
const { FriendlyError } = require('discord.js-commando');

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
  // The roundId specifies the round, and informs the fetcher on where to fetch from.
  // The initialSongIndex can optionally be used to start the round from somewhere other than the first song.
  constructor(roundId, initialSongIndex) {
    let parentDir = `${path.dirname(__dirname)}/tmp/rounds/${roundId}`;
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId, parentDir);
    this.songs = [];
    this.current = null;
    this.initialSongIndex = initialSongIndex;

    this.dirs = {
      parent: parentDir,
      download: `${parentDir}/download`,
      transcode: `${parentDir}/transcode`,
      announcer: `${parentDir}/announcer`
    };

    this._makeDirectories();
  }

  get roundPrefixAndId() {
    let id = this.roundId;
    let prefixThree = id.substring(0, 3);
    let prefixFour = id.substring(0, 4);

    if (prefixThree === 'OHC') {
      return { prefix: 'OHC', id: id.substring(3) };
    } else if (prefixFour === '2HTS') {
      return { prefix: '2HTS', id: id.substring(4) };
    } else if (prefixFour === '90MC') {
      return { prefix: '90MC', id: id.substring(4) };
    }
    return { prefix: null, id };
  }

  get title() {
    let prefixAndId = this.roundPrefixAndId;
    switch (prefixAndId.prefix) {
      case 'OHC':
        return `One Hour Compo Round ${prefixAndId.id}`;
      case '2HTS':
        return `Two Hour Track Sundays Round ${prefixAndId.id}`;
      case '90MC':
        return `Ninety Minute Compo Round ${prefixAndId.id}`;
      default:
        return this.roundId;
    }
  }

  nextSong() {
    let index;

    // If we have this.current, then the party has already started and we'll just go to the next.
    if (this.current) {
      let currentSongIndex = this.songs.findIndex((song) => song.id === this.current.song.id);
      index = currentSongIndex + 1;

    // Otherwise, this is the first song and we should reference the
    // initialSongIndex or just use the first song.
    } else {
      index = this.initialSongIndex || 0;

      if (index < 0 || index >= this.songs.length) {
        throw new FriendlyError('I can\'t play the requested song! It doesn\'t exist in the round.');
      }
    }

    let song = this.songs[index];
    if (song) {
      this.current = {
        index,
        song,
        total: this.songs.length
      };
    } else {
      this.current = null;
    }

    return this.current;
  }

  async fetchAndReconcileAllSongs() {
    console.log(`[Round->fetching] ${this.roundId}`.info);
    let fetchedSongs = await this.fetcher.fetch();
    this.songs = reconcileSongs(this.songs, fetchedSongs);
    console.log(`[Round->fetched] ${this.roundId}`.success);
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
