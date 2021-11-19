const fs = require('fs');
const { pipeline } = require('stream/promises');
const path = require('path');

const AWS = require('aws-sdk');
const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const prism = require('prism-media');
const streamifier = require('streamifier');
const builder = require('xmlbuilder');

class RoundExtraAnnouncer {
  constructor(roundTitle) {
    this.roundTitle = roundTitle;
  }

  async process(directory) {
    let limiter = new Bottleneck({
      maxConcurrent: 3,
      minTime: 333,
    });

    let announcers = [
      {
        id: 'outro',
        text: [
          `The listening party for ${this.roundTitle} is now over.`,
          'I hope you had a great time!',
          "Don't forget to vote!",
        ],
      },
    ];

    let processPromises = announcers.map((announcer) => {
      return limiter.schedule(() => this.processIndividual(announcer, directory));
    });

    return await Promise.all(processPromises);
  }

  speech(announcer) {
    let msg = builder
      .create('speak', { headless: true })
      .ele('amazon:domain', { name: 'conversational' });
    msg.ele('break', { time: '1500ms' });

    announcer.text.forEach((text, index) => {
      if (index > 0) {
        msg.ele('break', { strength: 'weak' });
      }
      msg.txt(text);
    });
    msg.ele('break', { time: '1500ms' });

    return msg.end();
  }

  async processIndividual(announcer, directory) {
    let polly = new AWS.Polly();
    let awsPath = path.join(directory, `${announcer.id}-aws.mp3`);
    let intermediatePath = path.join(directory, `${announcer.id}-intermediate.mp3`);
    let finalPath = path.join(directory, `${announcer.id}.mp3`);

    let params = {
      OutputFormat: 'mp3',
      Text: this.speech(announcer),
      VoiceId: 'Joanna',
      Engine: 'neural',
      SampleRate: '24000',
      TextType: 'ssml',
    };
    let response = await polly.synthesizeSpeech(params).promise();
    let pollyReadStream = streamifier.createReadStream(response.AudioStream);
    let pcmWriteStream = fs.createWriteStream(awsPath);

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

    announcer.path = finalPath;
    return announcer;
  }
}

module.exports = RoundExtraAnnouncer;
