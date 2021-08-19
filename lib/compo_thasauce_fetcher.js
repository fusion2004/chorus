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

      // Handle if we couldn't get a data attribute by providing an empty string as default
      let songId = $item.data('id') || '';
      let title = $item.data('title') || '';
      let artist = $item.data('author') || '';
      let url = ROOT_URL + songDownloadAnchor.attr('href');

      // cheerio.data can return a number or string, so this makes sure we only deal with strings
      let event = {
        songId: songId.toString(),
        title: title.toString(),
        artist: artist.toString(),
        url
      };
      song.service.send('FETCH_FINISH', event);
      return song;
    });

    return songs;
  }
}

module.exports = CompoThaSauceFetcher;
