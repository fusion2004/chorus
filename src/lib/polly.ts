import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import builder from 'xmlbuilder';

// Single shared PollyClient — the one place credentials/region defaults and
// SDK-level settings live.
const polly = new PollyClient({});

// Shared synthesis settings. Anything that should stay in lockstep across
// every Polly call (voice, engine, sample rate, format) belongs here.
const SYNTHESIZE_SETTINGS = {
  OutputFormat: 'mp3',
  VoiceId: 'Joanna',
  Engine: 'generative',
  SampleRate: '24000',
  TextType: 'ssml',
} as const;

// XMLElement isn't directly exported by xmlbuilder's types; this lets callers
// pass a build callback without needing to import the type themselves.
type XmlNode = ReturnType<typeof builder.create>;

/**
 * Builds an SSML fragment wrapped in the standard envelope used by every
 * announcer: `<speak>` with a 1500ms break before and after the caller-provided
 * content.
 *
 * Note: we used to wrap the body in `<amazon:domain name="conversational">`,
 * but that tag is only supported by the neural engine. The generative engine
 * rejects it with `ValidationException: This voice does not support one of the
 * used SSML features` and has its own conversational style baked in.
 */
export function buildSsml(build: (msg: XmlNode) => void): string {
  const msg = builder.create('speak', { headless: true });
  msg.ele('break', { time: '1500ms' });
  build(msg);
  msg.ele('break', { time: '1500ms' });
  return msg.end();
}

/**
 * Synthesizes the given SSML via Polly and writes the returned MP3 stream to
 * outputPath. Throws if Polly returns no audio stream.
 */
export async function synthesizeToFile(ssml: string, outputPath: string): Promise<void> {
  const command = new SynthesizeSpeechCommand({ ...SYNTHESIZE_SETTINGS, Text: ssml });
  const response = await polly.send(command);
  if (!response.AudioStream) throw new Error('Polly returned no audio stream');
  const pollyStream = response.AudioStream as Readable;
  const outStream = fs.createWriteStream(outputPath);
  await pipeline(pollyStream, outStream);
}
