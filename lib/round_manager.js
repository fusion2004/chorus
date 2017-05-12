const CompoThaSauceFetcher = require('../lib/compo_thasauce_fetcher');

class RoundManager {
  constructor(roundId) {
    this.roundId = roundId;
    this.fetcher = new CompoThaSauceFetcher(roundId);
  }
}

module.exports = RoundManager;
