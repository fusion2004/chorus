// Ambient module declarations for packages that don't ship type definitions.
// These will be removed or updated as packages are replaced in later layers.

declare module 'discord.js-commando' {
  export class CommandoClient {
    constructor(options: any);
    registry: any;
    dispatcher: any;
    once(event: string, listener: (...args: any[]) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    channels: any;
    user: any;
    login(token: string): Promise<string>;
  }
  export class Command {
    constructor(client: CommandoClient, info: any);
    name: string;
    group: any;
  }
}

declare module 'nodeshout-napi' {
  export function init(): void;
  export function create(): any;
  export const ErrorTypes: { SUCCESS: number; [key: string]: number };
  export class ShoutStream {
    constructor(shout: any);
  }
}

declare module 'prism-media' {
  export class FFmpeg {
    constructor(options: { args: string[] });
    pipe(destination: any): any;
  }
}

declare module 'streamifier' {
  import { Readable } from 'stream';
  export function createReadStream(data: any): Readable;
}

declare module 'zippa' {
  const zippa: any;
  export = zippa;
}
