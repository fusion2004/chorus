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
    if (partyService.state.matches('idle')) {
      message.reply('there is no listening party, currently!');
      return;
    } else if (partyService.state.matches('partying.streaming.idle')) {
      message.reply("the listening party isn't skippable yet!");
      return;
    }

    partyService.send('SKIP_SONG');
  }
};
