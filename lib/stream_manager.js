const fs = require('fs');
const stream = require('stream');
const util = require('util');
const EventEmitter = require('events');
const nodeshout = require('nodeshout');

const RoundAnnouncer = require('../lib/round_announcer');
const RoundFetcher = require('../lib/round_fetcher');
const RoundManager = require('../lib/round_manager');
const RoundTranscoder = require('../lib/round_transcoder');
const fetchEnv = require('../utils/fetch-env');
const { announcerFinal, transcodeFinal } = require('../utils/symbols');

const { ShoutStream } = nodeshout;
const pipeline = util.promisify(stream.pipeline);

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
    this._shout.setName(`${this.roundId} Listening Party`);
    this._shout.setAudioInfo('bitrate', '320');
    this._shout.setAudioInfo('samplerate', '44100');
    this._shout.setAudioInfo('channels', '2');

    this.emit('compoMetadataFetching');
    await this.roundManager.fetchAndReconcileAllSongs();
    if (this.stopped) {
      return;
    }

    await this.roundManager.transitionProcessedSongs();
    if (this.stopped) {
      return;
    }

    this.emit('fetchingSongs');
    await this.roundFetcher.fetch();
    if (this.stopped) {
      return;
    }

    this.emit('transcodingSongs');
    await this.roundTranscoder.transcode();
    if (this.stopped) {
      return;
    }

    await this.roundManager.parseMetadata();
    if (this.stopped) {
      return;
    }

    this.emit('generatingAnnouncer');
    await this.roundAnnouncer.process();
    if (this.stopped) {
      return;
    }

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

    this.emit('intro');
    await pipeline(this.fileStream, this.shoutStream);
  }

  async playSong(song) {
    this.fileStream = fs.createReadStream(song.path(announcerFinal), { highWaterMark: 65536 });
    this.shoutStream = new ShoutStream(this._shout);

    this.emit('playing', song);

    await pipeline(this.fileStream, this.shoutStream);

    this.fileStream = fs.createReadStream(song.path(transcodeFinal), { highWaterMark: 65536 });
    this.shoutStream = new ShoutStream(this._shout);

    await pipeline(this.fileStream, this.shoutStream);
  }

  async refetch() {
    await this.roundManager.fetchAndReconcileAllSongs();
    await this.roundManager.transitionProcessedSongs();
    await this.roundFetcher.fetch();
    await this.roundTranscoder.transcode();
    await this.roundManager.parseMetadata();
    await this.roundAnnouncer.process();
  }

  skipSong() {
    this._stopCurrentSong();
  }

  stop() {
    this.stopped = true;
    this._stopCurrentSong();
  }

  _stopCurrentSong() {
    // If we don't have any song loaded, there's nothing to stop!
    if (!this.fileStream) {
      return;
    }
    this.fileStream.unpipe(this.shoutStream);
    this.shoutStream.end();
  }
}

module.exports = StreamManager;
