const EventEmitter = require('events');
const nodeshout = require('nodeshout');
const Promise = require('bluebird');
const RoundAnnouncer = require('../lib/round_announcer');
const RoundFetcher = require('../lib/round_fetcher');
const RoundManager = require('../lib/round_manager');
const RoundTranscoder = require('../lib/round_transcoder');
const fetchEnv = require('../utils/fetch-env');

const fs = require('fs');

const { ShoutStream } = nodeshout;

nodeshout.init();

class StreamManager extends EventEmitter {
  constructor(roundId) {
    super();
    this._shout = nodeshout.create();
    this.host = fetchEnv('HUBOT_STREAM_HOST');
    this.port = fetchEnv('HUBOT_STREAM_PORT');
    this.mount = fetchEnv('HUBOT_STREAM_MOUNT');
    this.roundId = roundId;
    this.roundManager = new RoundManager(roundId);
    this.roundFetcher = new RoundFetcher(this.roundManager);
    this.roundTranscoder = new RoundTranscoder(this.roundManager);
    this.roundAnnouncer = new RoundAnnouncer(this.roundManager);
    this.stopped = false;
  }

  streamUrl() {
    return `http://${this.host}:${this.port}/${this.mount}.m3u`;
  }

  async start() {
    this._shout.setHost(this.host);
    this._shout.setPort(this.port);
    this._shout.setUser('source');
    this._shout.setPassword(fetchEnv('HUBOT_STREAM_SOURCE_PASSWORD'));
    this._shout.setMount(this.mount);
    this._shout.setFormat(1); // 0=ogg, 1=mp3
    // this._shout.setAudioInfo('bitrate', '192');
    // this._shout.setAudioInfo('samplerate', '44100');
    // this._shout.setAudioInfo('channels', '2');
    // this._shout.open();

    this.emit('compoMetadataFetching');
    await this.roundManager.getAllSongs();

    this.emit('fetchingSongs');
    await this.roundFetcher.fetch();

    this.emit('transcodingSongs');
    await this.roundTranscoder.transcode();

    this.emit('generatingAnnouncer');
    await this.roundAnnouncer.process();

    this.emit('startingStream');
    this._shout.open();

    await this.playIntro();

    while (this.roundManager.nextSong()) {
      let song = this.roundManager.currentSong;

      if (this.stopped) {
        break;
      }

      await this.playSong(song);
    }

    this._shout.close();
    this.emit('finish');
    this.stopped = true;
  }

  async playIntro() {
    this.fileStream = fs.createReadStream('./music/intro.mp3', { highWaterMark: 65536 });
    this.shoutStream = new ShoutStream(this._shout);
    let songStream = this.fileStream.pipe(this.shoutStream);

    this.emit('intro');

    return new Promise(function(resolve) {
      songStream.on('finish', function() {
        resolve();
      });
    });
  }

  async playSong(song) {
    this.fileStream = fs.createReadStream(song.paths.announcer, { highWaterMark: 65536 });
    this.shoutStream = new ShoutStream(this._shout);

    this.emit('playing', song);

    return new Promise((resolve) => {
      let announcerStream = this.fileStream.pipe(this.shoutStream);
      announcerStream.on('finish', () => {
        this.fileStream = fs.createReadStream(song.paths.final, { highWaterMark: 65536 });
        this.shoutStream = new ShoutStream(this._shout);

        let songStream = this.fileStream.pipe(this.shoutStream);

        songStream.on('finish', () => {
          resolve();
        });
      });
    });
  }

  skipSong() {
    this._stopCurrentSong();
  }

  stop() {
    this.stopped = true;
    this._stopCurrentSong();
  }

  _stopCurrentSong() {
    this.fileStream.unpipe(this.shoutStream);
    this.shoutStream.end();
  }
}

module.exports = StreamManager;
