import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import Bottleneck from 'bottleneck';
import { FFmpeg } from 'prism-media';
import { sample } from 'lodash';
import builder from 'xmlbuilder';

import { announcerAws, announcerFinal, announcerIntermediate } from '../utils/symbols';
import type { Song } from './song';

const polly = new PollyClient({});

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

    const msg = builder
      .create('speak', { headless: true })
      .ele('amazon:domain', { name: 'conversational' });
    msg.ele('break', { time: '1500ms' });
    if (firstTrack) {
      msg.txt(`Welcome to the listening party for ${this.roundTitle}.`);
      msg.ele('break');
    }
    bumper.forEach((text: string, index: number) => {
      if (index > 0) msg.ele('break', { strength: 'weak' });
      msg.txt(text);
    });
    msg.ele('break', { time: '1500ms' });

    return msg.end();
  }

  async processSong(song: Song, firstTrack: boolean): Promise<void> {
    const awsPath = song.path(announcerAws);
    const intermediatePath = song.path(announcerIntermediate);
    const finalPath = song.path(announcerFinal);

    const command = new SynthesizeSpeechCommand({
      OutputFormat: 'mp3',
      Text: this.speech(song, firstTrack),
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'ssml',
    });

    const response = await polly.send(command);
    if (!response.AudioStream) throw new Error('Polly returned no audio stream');
    const pollyStream = response.AudioStream as Readable;
    const pcmWriteStream = fs.createWriteStream(awsPath);

    song.service.send({ type: 'START_ANNOUNCER_DL_AND_TRANSCODE' });

    await pipeline(pollyStream, pcmWriteStream);

    const pcmReadStream = fs.createReadStream(awsPath);
    const encodeStream = new FFmpeg({
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
