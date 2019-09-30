const fs = require('fs');
const AWS = require('aws-sdk');
const Promise = require('bluebird');
const lame = require('lame');
const sox = require('sox.js');
const streamifier = require('streamifier');

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
    let promise = new Promise((resolve, reject) => {
      let polly = new AWS.Polly();
      let awsPath = `${this.roundManager.dirs.announcer}/${song.filename({ type: 'announcer-aws' })}`;
      let pcmPath = `${this.roundManager.dirs.announcer}/${song.filename({ type: 'announcer-pcm' })}`;
      let finalPath = `${this.roundManager.dirs.announcer}/${song.filename()}`;

      let text = `Next up: ${song.title} by ${song.artist}`;

      let params = {
        OutputFormat: 'mp3',
        Text: text,
        VoiceId: 'Joanna',
        Engine: 'neural',
        SampleRate: '24000',
        TextType: 'text'
      };
      polly.synthesizeSpeech(params).promise().then((response) => {
        let readStream = streamifier.createReadStream(response.AudioStream);
        let writeStream = fs.createWriteStream(awsPath);

        let pipe = readStream.pipe(writeStream);

        pipe.on('finish', () => {
          sox({
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
            let writeStream = fs.createWriteStream(finalPath);

            let pipe = readStream.pipe(encodeStream).pipe(writeStream);

            pipe.on('finish', () => {
              fs.unlink(awsPath, (err) => {
                if (err) {
                  reject(err);
                }

                fs.unlink(pcmPath, (err) => {
                  if (err) {
                    reject(err);
                  }

                  song.paths.announcer = finalPath;
                  resolve();
                });
              });
            });
          });
        });
      });
    });

    await promise;
  }
}

module.exports = RoundAnnouncer;
