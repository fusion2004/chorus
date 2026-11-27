import fs from 'node:fs';

import Bottleneck from 'bottleneck';

import { encodeAudio } from './ffmpeg.js';
import type { StreamingMode } from './streaming/types.js';
import { downloadFinal, transcodeFinal, transcodeIntermediate } from '../utils/symbols.js';
import type { Song } from './song.js';

export class RoundTranscoder {
  streamTo: StreamingMode;

  constructor(streamTo: StreamingMode) {
    this.streamTo = streamTo;
  }

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

    await encodeAudio(song.path(downloadFinal), intermediatePath, this.streamTo);
    await fs.promises.rename(intermediatePath, finalPath);

    song.service.send({ type: 'FINISH_TRANSCODE' });
  }
}
