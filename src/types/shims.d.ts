// Ambient module declarations for packages that don't ship type definitions.

declare module 'nodeshout' {
  export interface ShoutT {
    setHost(host: string): number;
    setPort(port: number): number;
    setUser(user: string): number;
    setPassword(password: string): number;
    setMount(mount: string): number;
    setMeta(name: string, value: string): number;
    setContentFormat(format: number, usage: number, codecs: string | null): number;
    setAudioInfo(key: string, value: string): number;
    open(): number;
    close(): number;
    send(buf: Buffer, bytesRead: number): number;
    delay(): number;
    getError(): string | null;
    getErrno(): number;
    free(): void;
  }

  interface Nodeshout {
    init(): void;
    create(): ShoutT;
    shutdown(): void;
    getVersion(): string;
    ErrorTypes: { SUCCESS: number; [key: string]: number };
    Formats: {
      OGG: number;
      MP3: number;
      WEBM: number;
      MATROSKA: number;
      TEXT: number;
      [key: string]: number;
    };
    Usages: { AUDIO: number; VISUAL: number; TEXT: number; [key: string]: number };
    MetaKeys: {
      NAME: string;
      URL: string;
      GENRE: string;
      DESCRIPTION: string;
      [key: string]: string;
    };
    AudioInfoKeys: { BITRATE: string; SAMPLERATE: string; CHANNELS: string; QUALITY: string };
  }

  const nodeshout: Nodeshout;
  export default nodeshout;
}

declare module 'prism-media' {
  import { Duplex } from 'node:stream';

  class FFmpeg extends Duplex {
    constructor(options: { args: string[] });
  }

  const prism: { FFmpeg: typeof FFmpeg };
  export default prism;
}
