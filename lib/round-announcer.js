const fs = require('fs');
const stream = require('stream');
const util = require('util');

const AWS = require('aws-sdk');
const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const prism = require('prism-media');
const streamifier = require('streamifier');
const _ = require('lodash');
const builder = require('xmlbuilder');

const { announcerAws, announcerFinal, announcerIntermediate } = require('../utils/symbols');

const pipeline = util.promisify(stream.pipeline);

class RoundAnnouncer {
  constructor(roundTitle) {
    this.roundTitle = roundTitle;
  }

  async process(songs) {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333,
    });

    let songsToProcess = songs.filter((song) => song.service.state.matches('transcoded'));
    let [firstSong] = songs;

    let processPromises = songsToProcess.map((song) => {
      let firstTrack = song.id === firstSong.id;
      return limiter.schedule(() => this.processSong(song, firstTrack));
    });

    await Promise.all(processPromises);
  }

  speech(song, firstTrack) {
    let firstOrNext = firstTrack ? 'First' : 'Next';
    let options = [
      [`Our ${firstOrNext} entry is ${song.title} `, ` by ${song.artist}`],
      [`${firstOrNext} up, ${song.title} `, ` by ${song.artist}`],
      [`${firstOrNext}, we have ${song.title} `, ` by ${song.artist}`],
      [`The ${firstOrNext} entry is ${song.title} `, ` by ${song.artist}`],
    ];
    let bumper = _.sample(options);

    let msg = builder
      .create('speak', { headless: true })
      .ele('amazon:domain', { name: 'conversational' });
    msg.ele('break', { time: '1500ms' });
    if (firstTrack) {
      msg.txt(`Welcome to the listening party for ${this.roundTitle}.`);
      msg.ele('break');
    }
    bumper.forEach((text, index) => {
      if (index > 0) {
        msg.ele('break', { strength: 'weak' });
      }
      msg.txt(text);
    });
    msg.ele('break', { time: '1500ms' });

    return msg.end();
  }

  async processSong(song, firstTrack) {
    let polly = new AWS.Polly();
    let awsPath = song.path(announcerAws);
    let intermediatePath = song.path(announcerIntermediate);
    let finalPath = song.path(announcerFinal);

    let params = {
      OutputFormat: 'mp3',
      Text: this.speech(song, firstTrack),
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'ssml',
    };
    let response = await polly.synthesizeSpeech(params).promise();
    let pollyReadStream = streamifier.createReadStream(response.AudioStream);
    let pcmWriteStream = fs.createWriteStream(awsPath);

    song.service.send('START_ANNOUNCER_DL_AND_TRANSCODE');

    await pipeline(pollyReadStream, pcmWriteStream);

    let pcmReadStream = fs.createReadStream(awsPath);

    let encodeStream = new prism.FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        // '-f', 's16le',
        '-map_metadata',
        '-1',
        '-filter:a',
        'loudnorm',
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
    let mp3WriteStream = fs.createWriteStream(intermediatePath);

    await pipeline(pcmReadStream, encodeStream, mp3WriteStream);

    await fs.promises.rename(intermediatePath, finalPath);
    await fs.promises.unlink(awsPath);

    song.service.send('FINISH_ANNOUNCER_DL_AND_TRANSCODE');
  }
}

module.exports = RoundAnnouncer;
