const fs = require('fs');
const stream = require('stream');
const util = require('util');

const AWS = require('aws-sdk');
const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const lame = require('lame');
const soxCallback = require('sox.js');
const streamifier = require('streamifier');
const _ = require('lodash');

const { announcerAws, announcerFinal, announcerIntermediate, announcerPcm } = require('../utils/symbols');

const pipeline = util.promisify(stream.pipeline);
const sox = util.promisify(soxCallback);

class RoundAnnouncer {
  constructor(roundManager) {
    this.roundManager = roundManager;
  }

  async process() {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333
    });

    let songsToProcess = this.roundManager.songs.filter((song) => song.service.state.matches('transcoded'));

    let processPromises = songsToProcess.map((song, index) => {
      let firstTrack = index === 0;
      return limiter.schedule(() => this.processSong(song, firstTrack));
    });

    await Promise.all(processPromises);
  }

  speech(song, firstTrack) {
    let firstOrNext = firstTrack ? 'First' : 'Next';
    let options = [
      `Our ${firstOrNext} entry is ${song.title} <break strength="weak"/> by ${song.artist}`,
      `${firstOrNext} up, ${song.title} <break strength="weak"/> by ${song.artist}`,
      `${firstOrNext}, we have ${song.title} <break strength="weak"/> by ${song.artist}`,
      `The ${firstOrNext} entry is ${song.title} <break strength="weak"/> by ${song.artist}`,
      `${firstOrNext}, we have an entry called ${song.title} <break strength="weak"/> by ${song.artist}`
    ];
    let bumper = _.sample(options);

    let msg = '<speak><amazon:domain name="conversational"><break time="1500ms"/>';
    if (firstTrack) {
      msg = msg.concat(`Welcome to the listening party for ${this.roundManager.title}.<break/>`);
    }

    msg = msg.concat(bumper);
    msg = msg.concat('<break time="1500ms"/></amazon:domain></speak>');

    return msg;
  }

  async processSong(song, firstTrack) {
    let polly = new AWS.Polly();
    let awsPath = song.path(announcerAws);
    let pcmPath = song.path(announcerPcm);
    let intermediatePath = song.path(announcerIntermediate);
    let finalPath = song.path(announcerFinal);

    let params = {
      OutputFormat: 'mp3',
      Text: this.speech(song, firstTrack),
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'ssml'
    };
    let response = await polly.synthesizeSpeech(params).promise();
    let pollyReadStream = streamifier.createReadStream(response.AudioStream);
    let pcmWriteStream = fs.createWriteStream(awsPath);

    song.service.send('START_ANNOUNCER_DL_AND_TRANSCODE');

    await pipeline(pollyReadStream, pcmWriteStream);

    let soxParams = {
      global: {
        norm: true
      },
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
    let mp3WriteStream = fs.createWriteStream(intermediatePath);

    await pipeline(
      pcmReadStream,
      encodeStream,
      mp3WriteStream
    );

    await fs.promises.rename(intermediatePath, finalPath);
    await fs.promises.unlink(awsPath);
    await fs.promises.unlink(pcmPath);

    song.service.send('FINISH_ANNOUNCER_DL_AND_TRANSCODE');
  }
}

module.exports = RoundAnnouncer;
