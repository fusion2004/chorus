const got = require('got');
const cheerio = require('cheerio');

const ROOT_URL = 'http://compo.thasauce.net';

interface SongData {
  songId: string;
  title: string;
  artist: string;
  url: string;
}

export default class CompoThaSauceFetcher {
  roundId: string;

  constructor(roundId: string) {
    this.roundId = roundId;
  }

  url(): string {
    return `${ROOT_URL}/rounds/view/${this.roundId}`;
  }

  async fetch(): Promise<{ status: number; songs: SongData[] }> {
    const response = await got(this.url());
    const songs = this._createSongsFromResponseBody(response.body);
    return { status: response.statusCode, songs };
  }

  private _createSongsFromResponseBody(body: string): SongData[] {
    const $ = cheerio.load(body);
    const items = $('#round-entries .item');

    return items.toArray().map((item: any) => {
      const $item = $(item);
      const songDownloadAnchor = $item.find('.song-download');

      const songId = $item.data('id') || '';
      const title = $item.data('title') || '';
      const artist = $item.data('author') || '';
      const url = ROOT_URL + songDownloadAnchor.attr('href');

      return {
        songId: songId.toString(),
        title: title.toString(),
        artist: artist.toString(),
        url,
      };
    });
  }
}
