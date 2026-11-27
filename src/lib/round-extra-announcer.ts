import fs from 'node:fs';
import path from 'node:path';

import Bottleneck from 'bottleneck';

import { ANNOUNCER_LOUDNORM, encodeAudio } from './ffmpeg.js';
import { buildSsml, synthesizeToFile } from './polly.js';
import { encodedExt } from './streaming/format.js';
import type { StreamingMode } from './streaming/types.js';

interface Announcer {
  id: string;
  text: string[];
  path?: string;
}

export class RoundExtraAnnouncer {
  roundTitle: string;
  streamTo: StreamingMode;

  constructor(roundTitle: string, streamTo: StreamingMode) {
    this.roundTitle = roundTitle;
    this.streamTo = streamTo;
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
    const ext = encodedExt(this.streamTo);
    const awsPath = path.join(directory, `${announcer.id}-aws.mp3`);
    const intermediatePath = path.join(directory, `${announcer.id}-intermediate.${ext}`);
    const finalPath = path.join(directory, `${announcer.id}.${ext}`);

    await synthesizeToFile(this.speech(announcer), awsPath);

    await encodeAudio(awsPath, intermediatePath, this.streamTo, {
      audioFilter: ANNOUNCER_LOUDNORM,
    });
    await fs.promises.rename(intermediatePath, finalPath);
    await fs.promises.unlink(awsPath);

    announcer.path = finalPath;
    return announcer;
  }
}
