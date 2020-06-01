const { Command } = require('discord.js-commando');

const { store } = require('../../lib/chorus-store');

module.exports = class StartPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'stopparty',
      aliases: ['stop'],
      group: 'compoverse',
      memberName: 'stopparty',
      description: 'Stops any current listening parties',
      guildOnly: true
    });
  }

  async run(message) {
    let currentStream = store.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party to stop!');
      return;
    }

    currentStream.stop();
  }
};
