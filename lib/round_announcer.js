const fs = require('fs');
const stream = require('stream');
const util = require('util');

const AWS = require('aws-sdk');
const Promise = require('bluebird');
const lame = require('lame');
const soxCallback = require('sox.js');
const streamifier = require('streamifier');

const pipeline = util.promisify(stream.pipeline);
const sox = util.promisify(soxCallback);

class RoundAnnouncer {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async process() {
    // TODO: we're potentially processing too many of these at once and hitting
    // AWS rate limits. Rewrite slightly to use https://www.npmjs.com/package/bottleneck
    let processPromises = this.roundManager.songs.map((song) => {
      return this.processSong(song);
    });

    await Promise.all(processPromises);
  }

  async processSong(song) {
    let polly = new AWS.Polly();
    let awsPath = `${this.roundManager.dirs.announcer}/${song.filename({ type: 'announcer-aws' })}`;
    let pcmPath = `${this.roundManager.dirs.announcer}/${song.filename({ type: 'announcer-pcm' })}`;
    let finalPath = `${this.roundManager.dirs.announcer}/${song.filename()}`;

    // TODO: use randomization and song position to make this more dynamic
    let text = `Next up: ${song.title} by ${song.artist}`;

    let params = {
      OutputFormat: 'mp3',
      Text: text,
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'text'
    };
    let response = await polly.synthesizeSpeech(params).promise();
    let pollyReadStream = streamifier.createReadStream(response.AudioStream);
    let pcmWriteStream = fs.createWriteStream(awsPath);

    await pipeline(pollyReadStream, pcmWriteStream);

    let soxParams = {
      inputFile: awsPath,
      input: {
        type: 'mp3'
      },
      outputFile: pcmPath,
      output: {
        bits: 16,
        channels: 2,
        rate: 44100,
        type: 'raw'
      }
    };

    await sox(soxParams).catch((err) => {
      // If we get an error back from running sox (and it isn't just a warning)
      // then throw an error.
      if (err && !err.message.startsWith('sox WARN')) {
        if (err instanceof Error) {
          throw err;
        } else {
          // If it's not an error instance, assume it is a string we should wrap with an Error
          throw new Error(err);
        }
      }
    });

    let pcmReadStream = fs.createReadStream(pcmPath);
    let encodeStream = new lame.Encoder({
      // input
      bitDepth: 16,
      channels: 2,
      sampleRate: 44100,

      // output
      bitRate: 320,
      outSampleRate: 44100,
      mode: lame.JOINTSTEREO
    });
    let mp3WriteStream = fs.createWriteStream(finalPath);

    await pipeline(
      pcmReadStream,
      encodeStream,
      mp3WriteStream
    );

    await fs.promises.unlink(awsPath);
    await fs.promises.unlink(pcmPath);

    // eslint-disable-next-line require-atomic-updates
    song.paths.announcer = finalPath;
  }
}

module.exports = RoundAnnouncer;
