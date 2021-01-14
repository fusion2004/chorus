const { Command } = require('discord.js-commando');

const { store } = require('../../lib/chorus-store');

module.exports = class SkipSongCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'skipsong',
      aliases: ['skip'],
      group: 'compoverse',
      memberName: 'skipsong',
      description: 'Skips the currently playing song and starts the next song in a listening party',
      guildOnly: true
    });
  }

  async run(message) {
    let currentStream = store.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party, currently!');
      return;
    }

    currentStream.skipSong();
  }
};
