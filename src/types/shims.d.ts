// Ambient module declarations for packages that don't ship type definitions.

declare module 'nodeshout' {
  export interface ShoutT {
    setHost(host: string): void;
    setPort(port: number): void;
    setUser(user: string): void;
    setPassword(password: string): void;
    setMount(mount: string): void;
    setFormat(format: number): void;
    setName(name: string): void;
    setAudioInfo(key: string, value: string): void;
    open(): number;
    close(): void;
    send(buf: Buffer, bytesRead: number): void;
    delay(): number;
    sync(): void;
  }

  interface Nodeshout {
    init(): void;
    create(): ShoutT;
    shutdown(): void;
    getVersion(): string;
    ErrorTypes: { SUCCESS: number; [key: string]: number };
  }

  const nodeshout: Nodeshout;
  export default nodeshout;
}

declare module 'prism-media' {
  import { Duplex } from 'stream';

  export class FFmpeg extends Duplex {
    constructor(options: { args: string[] });
  }
}
