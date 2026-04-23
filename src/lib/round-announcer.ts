import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

import Bottleneck from 'bottleneck';
import prism from 'prism-media';
import { sample } from 'lodash-es';

import { announcerAws, announcerFinal, announcerIntermediate } from '../utils/symbols.js';
import { buildSsml, synthesizeToFile } from './polly.js';
import type { Song } from './song.js';

export class RoundAnnouncer {
  roundTitle: string;

  constructor(roundTitle: string) {
    this.roundTitle = roundTitle;
  }

  async process(songs: Song[]): Promise<void> {
    const limiter = new Bottleneck({ maxConcurrent: 3, minTime: 333 });
    const [firstSong] = songs;
    const songsToProcess = songs.filter((song) => song.service.getSnapshot().matches('transcoded'));

    await Promise.all(
      songsToProcess.map((song) =>
        limiter.schedule(() => this.processSong(song, song.id === firstSong.id)),
      ),
    );
  }

  speech(song: Song, firstTrack: boolean): string {
    const firstOrNext = firstTrack ? 'First' : 'Next';
    const options = [
      [`Our ${firstOrNext} entry is ${song.title} `, ` by ${song.artist}`],
      [`${firstOrNext} up, ${song.title} `, ` by ${song.artist}`],
      [`${firstOrNext}, we have ${song.title} `, ` by ${song.artist}`],
      [`The ${firstOrNext} entry is ${song.title} `, ` by ${song.artist}`],
    ];
    const bumper: string[] = sample(options) as string[];

    return buildSsml((msg) => {
      if (firstTrack) {
        msg.txt(`Welcome to the listening party for ${this.roundTitle}.`);
        msg.ele('break');
      }
      bumper.forEach((text: string, index: number) => {
        if (index > 0) msg.ele('break', { strength: 'weak' });
        msg.txt(text);
      });
    });
  }

  async processSong(song: Song, firstTrack: boolean): Promise<void> {
    const awsPath = song.path(announcerAws);
    const intermediatePath = song.path(announcerIntermediate);
    const finalPath = song.path(announcerFinal);

    song.service.send({ type: 'START_ANNOUNCER_DL_AND_TRANSCODE' });

    await synthesizeToFile(this.speech(song, firstTrack), awsPath);

    const pcmReadStream = fs.createReadStream(awsPath);
    const encodeStream = new prism.FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        '-map_metadata',
        '-1',
        '-filter:a',
        'loudnorm',
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
    const mp3WriteStream = fs.createWriteStream(intermediatePath);

    await pipeline(pcmReadStream, encodeStream, mp3WriteStream);
    await fs.promises.rename(intermediatePath, finalPath);
    await fs.promises.unlink(awsPath);

    song.service.send({ type: 'FINISH_ANNOUNCER_DL_AND_TRANSCODE' });
  }
}
