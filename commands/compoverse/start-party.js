const { Command } = require('discord.js-commando');

const { roleIds, memberHasOneOfTheseRoles } = require('../../utils/roles');

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
    let authorized = memberHasOneOfTheseRoles(message.member, [roleIds.thasauceAdmin, roleIds.compoAdmin]);
    if (!authorized) {
      return;
    }

    message.say('lets goooo');
  }
};
