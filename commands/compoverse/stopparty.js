const { Command } = require('discord.js-commando');

const { partyService } = require('../../lib/party');

module.exports = class StopPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'stopparty',
      aliases: ['stop'],
      group: 'compoverse',
      memberName: 'stopparty',
      description: 'Stops any current listening parties',
      guildOnly: true,
    });
  }

  async run(message) {
    let currentStream = partyService.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party to stop!');
      return;
    }

    currentStream.stop();
  }
};
