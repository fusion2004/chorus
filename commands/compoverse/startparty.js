const { Command } = require('discord.js-commando');

const { partyService } = require('../../lib/party');

module.exports = class StartPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'startparty',
      aliases: ['party'],
      group: 'compoverse',
      memberName: 'startparty',
      description: 'Starts a listening party for a Compo round',
      guildOnly: true,
      args: [
        {
          key: 'round',
          prompt: 'What round would you like to start a party for?',
          type: 'string',
        },
        {
          key: 'initialSongIndex',
          prompt: "What's the index of the song we should start on?",
          type: 'integer',
          default: 0,
        },
      ],
    });
  }

  async run(message, { round, initialSongIndex }) {
    if (partyService.state.matches('partying')) {
      message.reply(
        'there is currently a listening party streaming. We can only stream one at a time.'
      );
      return;
    }

    round = round.toUpperCase();
    partyService.send({ type: 'START', channel: message.channel, round });
  }
};
