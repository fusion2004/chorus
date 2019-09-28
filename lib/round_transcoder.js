const fs = require('fs');
const Promise = require('bluebird');
const lame = require('lame');

class RoundTranscoder {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async transcode() {
    let transcoderPromises = this.roundManager.songs.map((song) => {
      return new Promise((resolve) => {
        let transcodePath = `${this.roundManager.dirs.transcode}/${song.filename()}`;
        let finalPath = `${this.roundManager.dirs.final}/${song.filename()}`;
        // let writestream = fs.createWriteStream(temppath);
        // let requeststream = request(song.url);

        // let pipe = requeststream.pipe(writestream);

        let readStream = fs.createReadStream(song.paths.download);
        let decodeStream = new lame.Decoder();
        let encodeStream = new lame.Encoder({
          // input
          channels: 2,        // 2 channels (left and right)
          bitDepth: 16,       // 16-bit samples
          sampleRate: 44100,  // 44,100 Hz sample rate

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
    });

    await Promise.all(transcoderPromises);
  }
}

module.exports = RoundTranscoder;
