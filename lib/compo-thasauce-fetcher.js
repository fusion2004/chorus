const got = require('got');
const cheerio = require('cheerio');

const ROOT_URL = 'http://compo.thasauce.net';

class CompoThaSauceFetcher {
  constructor(roundId) {
    this.roundId = roundId;
  }

  url() {
    return `${ROOT_URL}/rounds/view/${this.roundId}`;
  }

  async fetch() {
    let response = await got(this.url());
    let html = await response.body;
    let songs = this._createSongsFromResponseBody(html);

    return { status: response.statusCode, songs };
  }

  _createSongsFromResponseBody(body) {
    let $ = cheerio.load(body);
    let items = $('#round-entries .item');

    let songs = items.toArray().map((item) => {
      let $item = $(item);
      let songDownloadAnchor = $item.find('.song-download');

      // Handle if we couldn't get a data attribute by providing an empty string as default
      let songId = $item.data('id') || '';
      let title = $item.data('title') || '';
      let artist = $item.data('author') || '';
      let url = ROOT_URL + songDownloadAnchor.attr('href');

      // cheerio.data can return a number or string, so this makes sure we only deal with strings
      return {
        songId: songId.toString(),
        title: title.toString(),
        artist: artist.toString(),
        url,
      };
    });

    return songs;
  }
}

module.exports = CompoThaSauceFetcher;
