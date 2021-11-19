const { Command } = require('discord.js-commando');

const { partyService } = require('../../lib/party');

module.exports = class RefetchPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'refetchparty',
      aliases: ['refetch'],
      group: 'compoverse',
      memberName: 'refetchparty',
      description: 'Refetches the round for the current listening party (to load new entries)',
      guildOnly: true,
    });
  }

  async run(message) {
    if (partyService.state.matches('idle')) {
      message.reply('there is no listening party, currently!');
      return;
    } else if (!partyService.state.matches('partying.processing.idle')) {
      message.reply('there is already a fetch or refetch running!');
      return;
    }

    partyService.send('REFETCH', { channel: message.channel });
  }
};
