import fs from 'node:fs';
import path from 'node:path';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';

import { songMachine } from './machines.js';
import { escapeDiscordMarkdown } from '../utils/markdown.js';
import {
  announcerAws,
  announcerFinal,
  announcerIntermediate,
  downloadFinal,
  downloadIntermediate,
  transcodeFinal,
  transcodeIntermediate,
} from '../utils/symbols.js';
import type { IAudioMetadata } from 'music-metadata';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(durationInSeconds: number): string {
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = `${Math.floor(durationInSeconds % 60)}`;
  return `${minutes}:${seconds.padStart(2, '0')}`;
}

export class Song {
  directory: string;
  service: Actor<typeof songMachine>;

  constructor(directory: string) {
    this.directory = directory;
    this.service = createActor(songMachine);
    this.service.subscribe((snapshot) => {
      if (snapshot.value === 'init') return;
      console.log(`[Song->${String(snapshot.value)}] Song #${this.id} - ${this.title}`);
    });
    this.service.start();
  }

  get id(): string | undefined {
    return this.service.getSnapshot().context.id;
  }

  get title(): string | undefined {
    return this.service.getSnapshot().context.title;
  }

  get safeTitle(): string {
    return escapeDiscordMarkdown(this.title ?? '');
  }

  get artist(): string | undefined {
    return this.service.getSnapshot().context.artist;
  }

  get safeArtist(): string {
    return escapeDiscordMarkdown(this.artist ?? '');
  }

  get url(): string | undefined {
    return this.service.getSnapshot().context.url;
  }

  get metadata(): IAudioMetadata | undefined {
    return this.service.getSnapshot().context.metadata;
  }

  get formattedDuration(): string | null {
    const { metadata } = this.service.getSnapshot().context;
    if (metadata?.format?.duration) {
      return formatDuration(metadata.format.duration);
    }
    return null;
  }

  path(type: symbol): string {
    switch (type) {
      case announcerAws:
      case announcerFinal:
      case announcerIntermediate:
        return path.join(this.directory, 'announcer', this.filename(type));
      case downloadFinal:
      case downloadIntermediate:
        return path.join(this.directory, 'download', this.filename(type));
      case transcodeFinal:
      case transcodeIntermediate:
        return path.join(this.directory, 'transcode', this.filename(type));
      default:
        throw new Error(`Unknown file type symbol`);
    }
  }

  filename(type: symbol): string {
    switch (type) {
      case announcerAws:
        return `${this.id}-announcer-aws.mp3`;
      case announcerFinal:
        return `${this.id}-announcer.mp3`;
      case announcerIntermediate:
        return `${this.id}-announcer-intermediate.mp3`;
      case downloadFinal:
        return `${this.id}-download.mp3`;
      case downloadIntermediate:
        return `${this.id}-download-intermediate.mp3`;
      case transcodeFinal:
        return `${this.id}-transcode.mp3`;
      case transcodeIntermediate:
        return `${this.id}-transcode-intermediate.mp3`;
      default:
        throw new Error(`Unknown file type symbol`);
    }
  }

  async transitionIfProcessed(): Promise<{ id: string | undefined; action: string | false }> {
    const finalDownloadExists = await fileExists(this.path(downloadFinal));
    const finalTranscodeExists = await fileExists(this.path(transcodeFinal));

    if (finalTranscodeExists) {
      this.service.send({ type: 'SKIP_TRANSCODE' });
      return { id: this.id, action: 'SKIP_TRANSCODE' };
    } else if (finalDownloadExists) {
      this.service.send({ type: 'SKIP_DOWNLOAD' });
      return { id: this.id, action: 'SKIP_DOWNLOAD' };
    } else {
      return { id: this.id, action: false };
    }
  }
}
