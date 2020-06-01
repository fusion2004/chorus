const { CommandoClient } = require('discord.js-commando');
const path = require('path');

const fetchEnv = require('./utils/fetch-env');

let client = new CommandoClient({
  commandPrefix: '!',
  owner: '92330214046072832'
});

client.registry
  .registerDefaultTypes()
  .registerGroups([
    ['compoverse', 'Compoverse']
  ])
  .registerDefaultGroups()
  .registerDefaultCommands()
  .registerCommandsIn(path.join(__dirname, 'commands'));

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}! (${client.user.id})`);
  client.user.setActivity('with Commando');
});

client.on('error', console.error);

client.login(fetchEnv('HUBOT_DISCORD_TOKEN'));
