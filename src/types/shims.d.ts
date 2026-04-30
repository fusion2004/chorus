// Ambient module declarations for packages that don't ship type definitions.

declare module 'prism-media' {
  import { Duplex } from 'node:stream';

  class FFmpeg extends Duplex {
    constructor(options: { args: string[] });
  }

  const prism: { FFmpeg: typeof FFmpeg };
  export default prism;
}
