class Song {
  constructor({ id, title, artist, url }) {
    this.id = id;
    this.title = title;
    this.artist = artist;
    this.url = url;

    this.paths = {
      download: null,
      transcode: null,
      final: null
    };
  }

  filename() {
    return `${this.id}.mp3`;
  }
}

module.exports = Song;
