const nodeFetch = require('node-fetch');
const cheerio = require('cheerio');
const Song = require('./song.js');

const ROOT_URL = 'http://compo.thasauce.net';

class CompoThaSauceFetcher {
  constructor(roundId, parentDir) {
    this.roundId = roundId;
    this.parentDir = parentDir;
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

    let songs = items.toArray().map((item) => {
      let $item = $(item);
      let songDownloadAnchor = $item.find('.song-download');

      let song = new Song(this.parentDir);
      let event = {
        songId: $item.data('id'),
        title: $item.data('title'),
        artist: $item.data('author'),
        url: ROOT_URL + songDownloadAnchor.attr('href')
      };
      song.service.send('FETCH_FINISH', event);
      return song;
    });

    return songs;
  }
}

module.exports = CompoThaSauceFetcher;
