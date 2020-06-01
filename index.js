const path = require('path');
const colors = require('colors');
const { CommandoClient } = require('discord.js-commando');

const fetchEnv = require('./utils/fetch-env');

// importing colors extends the String prototype so we can call these directly
// on strings: 'something went wrong'.error
colors.setTheme({
  info: 'blue',
  help: 'cyan',
  warn: 'yellow',
  success: 'green',
  error: 'red'
});

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
