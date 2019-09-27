const nodeFetch = require('node-fetch');
const cheerio = require('cheerio');
const Song = require('./song.js');

const ROOT_URL = 'http://compo.thasauce.net';

class CompoThaSauceFetcher {
  constructor(roundId) {
    this.roundId = roundId;
  }

  url() {
    return `${ROOT_URL}/rounds/view/${this.roundId}`;
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
      let songDownloadAnchor = $item.find('.song-download');

      return new Song({
        id: $item.data('id'),
        title: $item.data('title'),
        artist: $item.data('author'),
        url: ROOT_URL + songDownloadAnchor.attr('href')
      });
    });

    return songs;
  }
}

module.exports = CompoThaSauceFetcher;
