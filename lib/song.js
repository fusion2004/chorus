class Song {
  constructor({ id, title, artist, url }) {
    this.id = id;
    this.title = title;
    this.artist = artist;
    this.url = url;
    this.metadata = null;

    this.paths = {
      download: null,
      transcode: null,
      final: null,
      announcer: null
    };
  }

  filename({ type } = { type: 'final' }) {
    switch (type) {
      case 'transcode-pcm':
        return `${this.id}.pcm`;
      case 'announcer-aws':
        return `${this.id}-aws.mp3`;
      case 'announcer-pcm':
        return `${this.id}-aws.pcm`;
      default:
        return `${this.id}.mp3`;
    }
  }
}

module.exports = Song;
