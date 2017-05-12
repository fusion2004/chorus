const CompoThaSauceFetcher = require('../lib/compo_thasauce_fetcher');

class RoundManager {
  constructor(roundId) {
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId);
  }

  async getSong() {
    await this.getAllSongs();

    console.log("here be datas: ========================")
    console.log(this.songs);
    // return this.songs[0];
  }

  async getAllSongs() {
    let songs = await this.fetcher.fetch();
    this.songs = songs;
  }
}

module.exports = RoundManager;
