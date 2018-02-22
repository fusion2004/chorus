const nodeFetch = require('node-fetch');
const cheerio = require('cheerio');

class CompoThaSauceFetcher {
  constructor(roundId) {
    this.roundId = roundId;
  }

  url() {
    return `http://compo.thasauce.net/rounds/view/${this.roundId}`;
  }

  async fetch() {
    let response = await nodeFetch(this.url());
    let html = await response.text();

    return this._createSongsFromResponseBody(html);
  }

  _createSongsFromResponseBody(body) {
    let $ = cheerio.load(body);
    let items = $('#round-entries .item');

    let songs = items.toArray().map(function(item) {
      let $item = $(item);

      return {
        id: $item.data('id'),
        title: $item.data('title'),
        artist: $item.data('author')
      };
    });

    return songs;
  }
}

module.exports = CompoThaSauceFetcher;
