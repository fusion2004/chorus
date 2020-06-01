const { Command } = require('discord.js-commando');

module.exports = class StartPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'startparty',
      aliases: [],
      group: 'compoverse',
      memberName: 'startparty',
      description: 'Starts a listening party for a Compo round',
      guildOnly: true
    });
  }

  async run(message) {
    message.say('lets goooo');
  }
};
