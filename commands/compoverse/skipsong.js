const { Command } = require('discord.js-commando');

const { partyService } = require('../../lib/party');

module.exports = class SkipSongCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'skipsong',
      aliases: ['skip'],
      group: 'compoverse',
      memberName: 'skipsong',
      description: 'Skips the currently playing song and starts the next song in a listening party',
      guildOnly: true,
    });
  }

  async run(message) {
    let currentStream = partyService.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party, currently!');
      return;
    }

    currentStream.skipSong();
  }
};
