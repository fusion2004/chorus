const EventEmitter = require('events');
const nodeshout = require('nodeshout');
const RoundManager = require('../lib/round_manager');

const { FileReadStream, ShoutStream } = nodeshout;

nodeshout.init();

class StreamManager extends EventEmitter {
  constructor(roundId) {
    super();
    this._shout = nodeshout.create();
    this.host = 'localhost';
    this.port = 8000;
    this.mount = 'stream';
    this.roundId = roundId;
    this.roundManager = new RoundManager(roundId);
  }

  streamUrl() {
    return `http://${this.host}:${this.port}/${this.mount}.m3u`;
  }

  async start() {
    this._shout.setHost(this.host);
    this._shout.setPort(this.port);
    this._shout.setUser('source');
    this._shout.setPassword('hackme');
    this._shout.setMount(this.mount);
    this._shout.setFormat(1); // 0=ogg, 1=mp3
    this._shout.setAudioInfo('bitrate', '192');
    this._shout.setAudioInfo('samplerate', '44100');
    this._shout.setAudioInfo('channels', '2');

    let song = await this.roundManager.getSong();
    console.log(song);

    this._shout.open();

    // Create file read stream and shout stream
    let fileStream = new FileReadStream('./music/01.mp3', 65536);
    let shoutStream = new ShoutStream(this._shout);
    fileStream.pipe(shoutStream);

    // setTimeout(function() {
    //   console.log('kill it early');
    //   fileStream.unpipe(shoutStream);
    //   shoutStream.end();
    // }, 10000);

    shoutStream.on('finish', () => {
      this.emit('finish');
      this._shout.close();
    });
  }
}

module.exports = StreamManager;
