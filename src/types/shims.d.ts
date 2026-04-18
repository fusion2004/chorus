// Ambient module declarations for packages that don't ship type definitions.
// These will be removed or updated as packages are replaced in later layers.

declare module 'nodeshout' {
  export function init(): void;
  export function create(): ShoutT;
  export function shutdown(): void;
  export function getVersion(): string;
  export const ErrorTypes: { SUCCESS: number; [key: string]: number };

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
}

declare module 'prism-media' {
  export class FFmpeg {
    constructor(options: { args: string[] });
    pipe(destination: any): any;
  }
}

