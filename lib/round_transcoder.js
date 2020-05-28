const fs = require('fs');
const stream = require('stream');
const util = require('util');

const Promise = require('bluebird');
const lame = require('lame');
const mm = require('music-metadata');
const soxCallback = require('sox.js');

const pipeline = util.promisify(stream.pipeline);
const sox = util.promisify(soxCallback);

class RoundTranscoder {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async transcode() {
    let transcoderPromises = this.roundManager.songs.map((song) => {
      return this.transcodeSong(song);
    });

    await Promise.all(transcoderPromises);
  }

  async transcodeSong(song) {
    let metadata = await mm.parseFile(song.paths.download);

    // The eslint rule here is trying to prevent accidental race conditions,
    // because we're accessing data on song and then setting it based on the
    // result of the await here. This should be fine because we can't get to
    // the transcode step until all of the download step is complete, and
    // nothing can get the metadata until the entire transcode step is done.
    // eslint-disable-next-line require-atomic-updates
    song.metadata = metadata;

    let pcmPath = `${this.roundManager.dirs.transcode}/${song.filename({ type: 'transcode-pcm' })}`;
    let transcodePath = `${this.roundManager.dirs.transcode}/${song.filename()}`;
    let finalPath = `${this.roundManager.dirs.final}/${song.filename()}`;
    let soxParams = {
      inputFile: song.paths.download,
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
    let writeStream = fs.createWriteStream(transcodePath);

    await pipeline(
      readStream,
      encodeStream,
      writeStream
    );

    await fs.promises.rename(transcodePath, finalPath);
    await fs.promises.unlink(pcmPath);

    // eslint-disable-next-line require-atomic-updates
    song.paths.final = finalPath;
  }
}

module.exports = RoundTranscoder;
