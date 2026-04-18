import fs from 'fs';
import { pipeline } from 'stream/promises';

import Bottleneck from 'bottleneck';
import { FFmpeg } from 'prism-media';

import { downloadFinal, transcodeFinal, transcodeIntermediate } from '../utils/symbols';
import type { Song } from './song';

export class RoundTranscoder {
  async transcode(songs: Song[]): Promise<void> {
    const limiter = new Bottleneck({ maxConcurrent: 3 });

    const songsToTranscode = songs.filter((song) =>
      song.service.getSnapshot().matches('downloaded'),
    );

    const transcoderPromises = songsToTranscode.map((song) =>
      limiter.schedule(() => this.transcodeSong(song)),
    );

    await Promise.all(transcoderPromises);
  }

  async transcodeSong(song: Song): Promise<void> {
    const intermediatePath = song.path(transcodeIntermediate);
    const finalPath = song.path(transcodeFinal);

    song.service.send({ type: 'START_TRANSCODE' });

    const readStream = fs.createReadStream(song.path(downloadFinal));
    const encodeStream = new FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        '-map_metadata',
        '-1',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'mp3',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '256k',
      ],
    });
    const writeStream = fs.createWriteStream(intermediatePath);

    await pipeline(readStream, encodeStream, writeStream);
    await fs.promises.rename(intermediatePath, finalPath);

    song.service.send({ type: 'FINISH_TRANSCODE' });
  }
}
