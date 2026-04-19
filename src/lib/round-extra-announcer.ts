import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import Bottleneck from 'bottleneck';
import prism from 'prism-media';
import builder from 'xmlbuilder';

const polly = new PollyClient({});

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
    const msg = builder
      .create('speak', { headless: true })
      .ele('amazon:domain', { name: 'conversational' });
    msg.ele('break', { time: '1500ms' });

    announcer.text.forEach((text: string, index: number) => {
      if (index > 0) msg.ele('break', { strength: 'weak' });
      msg.txt(text);
    });
    msg.ele('break', { time: '1500ms' });

    return msg.end();
  }

  async processIndividual(announcer: Announcer, directory: string): Promise<Announcer> {
    const awsPath = path.join(directory, `${announcer.id}-aws.mp3`);
    const intermediatePath = path.join(directory, `${announcer.id}-intermediate.mp3`);
    const finalPath = path.join(directory, `${announcer.id}.mp3`);

    const command = new SynthesizeSpeechCommand({
      OutputFormat: 'mp3',
      Text: this.speech(announcer),
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'ssml',
    });

    const response = await polly.send(command);
    if (!response.AudioStream) throw new Error('Polly returned no audio stream');
    const pollyStream = response.AudioStream as Readable;
    const pcmWriteStream = fs.createWriteStream(awsPath);

    await pipeline(pollyStream, pcmWriteStream);

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
