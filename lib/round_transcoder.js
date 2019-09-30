const fs = require('fs');
const Promise = require('bluebird');
const lame = require('lame');
const mm = require('music-metadata');
const sox = require('sox.js');

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

    let transcodePromise = new Promise((resolve, reject) => {
      let pcmPath = `${this.roundManager.dirs.transcode}/${song.filename({ type: 'transcode-pcm' })}`;
      let transcodePath = `${this.roundManager.dirs.transcode}/${song.filename()}`;
      let finalPath = `${this.roundManager.dirs.final}/${song.filename()}`;

      sox({
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
      }, (err) => {
        // If we get an error back from running sox (and it isn't just a warning)
        // then reject the promise.
        if (err && !err.message.startsWith('sox WARN')) {
          reject(err);
          return;
        }

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

        let pipe = readStream.pipe(encodeStream).pipe(writeStream);

        pipe.on('finish', () => {
          fs.rename(transcodePath, finalPath, (err) => {
            if (err) {
              reject(err);
            }

            fs.unlink(pcmPath, (err) =>  {
              if (err) {
                reject(err);
              }

              song.paths.final = finalPath;
              resolve();
            });
          });
        });
      });
    });

    await transcodePromise;
  }
}

module.exports = RoundTranscoder;
