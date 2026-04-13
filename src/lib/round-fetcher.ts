import fs from 'fs';
import { pipeline } from 'stream/promises';

import Bottleneck from 'bottleneck';
const got = require('got');

import { downloadFinal, downloadIntermediate } from '../utils/symbols';
import type { Song } from './song';

export class RoundFetcher {
  async fetch(songs: Song[]): Promise<void> {
    const limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333,
    });

    const songsToFetch = songs.filter((song) =>
      song.service.getSnapshot().matches('fetched')
    );

    const downloadPromises = songsToFetch.map((song) =>
      limiter.schedule(() => this.fetchSong(song))
    );

    await Promise.all(downloadPromises);
  }

  async fetchSong(song: Song): Promise<void> {
    const downloadPath = song.path(downloadIntermediate);
    const finalPath = song.path(downloadFinal);
    const writeStream = fs.createWriteStream(downloadPath);
    const requestStream = got.stream(song.url);

    song.service.send({ type: 'START_DOWNLOAD' });

    await pipeline(requestStream, writeStream);

    await fs.promises.rename(downloadPath, finalPath);

    song.service.send({ type: 'FINISH_DOWNLOAD' });
  }
}
