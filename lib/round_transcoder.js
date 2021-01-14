const fs = require('fs');
const stream = require('stream');
const util = require('util');

const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const lame = require('lame');
const soxCallback = require('sox.js');

const { downloadFinal, transcodeFinal, transcodeIntermediate, transcodePcm } = require('../utils/symbols');

const pipeline = util.promisify(stream.pipeline);
const sox = util.promisify(soxCallback);

class RoundTranscoder {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async transcode() {
    let limiter = new Bottleneck({
      maxConcurrent: 3
    });

    let songsToTranscode = this.roundManager.songs.filter((song) => song.service.state.matches('downloaded'));

    let transcoderPromises = songsToTranscode.map((song) => {
      return limiter.schedule(() => this.transcodeSong(song));
    });

    await Promise.all(transcoderPromises);
  }

  async transcodeSong(song) {
    let pcmPath = song.path(transcodePcm);
    let intermediatePath = song.path(transcodeIntermediate);
    let finalPath = song.path(transcodeFinal);
    let soxParams = {
      inputFile: song.path(downloadFinal),
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

    song.service.send('START_TRANSCODE');

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

    let readStream = fs.createReadStream(pcmPath);
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
    let writeStream = fs.createWriteStream(intermediatePath);

    await pipeline(
      readStream,
      encodeStream,
      writeStream
    );

    await fs.promises.rename(intermediatePath, finalPath);
    await fs.promises.unlink(pcmPath);

    song.service.send('FINISH_TRANSCODE');
  }
}

module.exports = RoundTranscoder;
