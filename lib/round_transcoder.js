const fs = require('fs');
const Promise = require('bluebird');
const lame = require('lame');
const mm = require('music-metadata');

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

    let transcodePromise = new Promise((resolve) => {
      let transcodePath = `${this.roundManager.dirs.transcode}/${song.filename()}`;
      let finalPath = `${this.roundManager.dirs.final}/${song.filename()}`;

      let readStream = fs.createReadStream(song.paths.download);
      let decodeStream = new lame.Decoder();
      let encodeStream = new lame.Encoder({
        // input
        channels: metadata.format.numberOfChannels,
        bitDepth: 16,
        sampleRate: metadata.format.sampleRate,

        // output
        bitRate: 320,
        outSampleRate: 44100,
        mode: lame.STEREO
      });
      let writeStream = fs.createWriteStream(transcodePath);

      let pipe = readStream.pipe(decodeStream).pipe(encodeStream).pipe(writeStream);

      pipe.on('finish', () => {
        fs.rename(transcodePath, finalPath, () => {
          song.paths.final = finalPath;
          resolve();
        });
      });
    });

    await transcodePromise;
  }
}

module.exports = RoundTranscoder;
