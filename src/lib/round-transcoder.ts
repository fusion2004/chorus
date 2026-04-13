const fs = require('fs');
const { pipeline } = require('stream/promises');

const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const prism = require('prism-media');

const { downloadFinal, transcodeFinal, transcodeIntermediate } = require('../utils/symbols');

class RoundTranscoder {
  async transcode(songs) {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
    });

    let songsToTranscode = songs.filter((song) => song.service.state.matches('downloaded'));

    let transcoderPromises = songsToTranscode.map((song) => {
      return limiter.schedule(() => this.transcodeSong(song));
    });

    await Promise.all(transcoderPromises);
  }

  async transcodeSong(song) {
    let intermediatePath = song.path(transcodeIntermediate);
    let finalPath = song.path(transcodeFinal);

    song.service.send('START_TRANSCODE');

    let readStream = fs.createReadStream(song.path(downloadFinal));
    let encodeStream = new prism.FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        // '-f', 's16le',
        '-map_metadata',
        '-1',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'mp3',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '256k',
      ],
    });
    let writeStream = fs.createWriteStream(intermediatePath);

    await pipeline(readStream, encodeStream, writeStream);

    await fs.promises.rename(intermediatePath, finalPath);

    song.service.send('FINISH_TRANSCODE');
  }
}

module.exports = RoundTranscoder;
