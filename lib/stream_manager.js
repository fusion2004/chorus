const EventEmitter = require('events');
const nodeshout = require('nodeshout');
const Promise = require('bluebird');
const RoundManager = require('../lib/round_manager');
const fetchEnv = require('../utils/fetch-env');

const { FileReadStream, ShoutStream } = nodeshout;

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
    this._shout.setAudioInfo('bitrate', '192');
    this._shout.setAudioInfo('samplerate', '44100');
    this._shout.setAudioInfo('channels', '2');
    this._shout.open();

    this.emit('compoMetadataFetching');
    await this.roundManager.getAllSongs();

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

  async playSong(song) {
    // Create file read stream and shout stream
    this.fileStream = new FileReadStream('./music/02.mp3', 65536);
    this.shoutStream = new ShoutStream(this._shout);
    let songStream = this.fileStream.pipe(this.shoutStream);

    this.emit('playing', song);

    return new Promise(function(resolve) {
      songStream.on('finish', function() {
        resolve();
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
