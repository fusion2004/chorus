const CompoThaSauceFetcher = require('../lib/compo_thasauce_fetcher');

class RoundManager {
  constructor(roundId) {
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId);
    this.songs = null;
    this.currentSong = null;
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
}

module.exports = RoundManager;
