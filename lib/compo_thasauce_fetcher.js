const nodeFetch = require('node-fetch');

class CompoThaSauceFetcher {
  constructor(roundId) {
    this.roundId = roundId;
  }

  url() {
    return `http://compo.thasauce.net/rounds/view/${this.roundId}`;
  }

  async fetch() {
    let response = await nodeFetch(this.url());
    return await response.text();
  }
}

module.exports = CompoThaSauceFetcher;
