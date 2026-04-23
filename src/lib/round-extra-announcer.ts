import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import Bottleneck from 'bottleneck';
import prism from 'prism-media';

import { buildSsml, synthesizeToFile } from './polly.js';

interface Announcer {
  id: string;
  text: string[];
  path?: string;
}

export class RoundExtraAnnouncer {
  roundTitle: string;

  constructor(roundTitle: string) {
    this.roundTitle = roundTitle;
  }

  async process(directory: string): Promise<Announcer[]> {
    const limiter = new Bottleneck({ maxConcurrent: 3, minTime: 333 });

    const announcers: Announcer[] = [
      {
        id: 'outro',
        text: [
          `The listening party for ${this.roundTitle} is now over.`,
          'I hope you had a great time!',
          "Don't forget to vote!",
        ],
      },
    ];

    return Promise.all(
      announcers.map((announcer) =>
        limiter.schedule(() => this.processIndividual(announcer, directory)),
      ),
    );
  }

  speech(announcer: Announcer): string {
    return buildSsml((msg) => {
      announcer.text.forEach((text: string, index: number) => {
        if (index > 0) msg.ele('break', { strength: 'weak' });
        msg.txt(text);
      });
    });
  }

  async processIndividual(announcer: Announcer, directory: string): Promise<Announcer> {
    const awsPath = path.join(directory, `${announcer.id}-aws.mp3`);
    const intermediatePath = path.join(directory, `${announcer.id}-intermediate.mp3`);
    const finalPath = path.join(directory, `${announcer.id}.mp3`);

    await synthesizeToFile(this.speech(announcer), awsPath);

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

    announcer.path = finalPath;
    return announcer;
  }
}
