const { Command } = require('discord.js-commando');

const { store } = require('../../lib/chorus-store');

module.exports = class RefetchPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'refetchparty',
      aliases: ['refetch'],
      group: 'compoverse',
      memberName: 'refetchparty',
      description: 'Refetches the round for the current listening party (to load new entries)',
      guildOnly: true
    });
  }

  async run(message) {
    let currentStream = store.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party, currently!');
      return;
    }

    await currentStream.refetch();
    message.reply(`${currentStream.roundId} refetched!`);
  }
};
