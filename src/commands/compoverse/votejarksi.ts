const { Command } = require('discord.js-commando');

module.exports = class VoteJarskiCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'votejarski',
      aliases: [],
      group: 'compoverse',
      memberName: 'votejarski',
      description: 'Remember to vote Jarski',
      guildOnly: true,
    });
  }

  async run(message) {
    message.say('Remember to always vote Jarski #1');
  }
};
