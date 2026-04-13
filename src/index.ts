// Setup process.env with the config from .env
require('dotenv').config();

const path = require('path');
const { CommandoClient } = require('discord.js-commando');

const fetchEnv = require('./utils/fetch-env');
const { log, setDebugChannel } = require('./lib/logger');
const { roleIds, memberHasOneOfTheseRoles } = require('./utils/roles');

let client = new CommandoClient({
  commandPrefix: '!',
  owner: '92330214046072832',
});

client.registry
  .registerDefaultTypes()
  .registerGroups([['compoverse', 'Compoverse']])
  .registerDefaultGroups()
  .registerDefaultCommands()
  .registerCommandsIn(path.join(__dirname, 'commands'));

client.once('ready', async () => {
  let debugChannel = await client.channels.fetch(fetchEnv('DEBUG_CHANNEL_ID'));
  setDebugChannel(debugChannel);
  log(`Booted up in ${process.env.NODE_ENV} environment!`);
  log(`Logged in as ${client.user.tag}! (${client.user.id})`);
});

client.on('error', console.error);

client.on('commandError', (command, error) => {
  console.error(`Error running command: ${command.name}`);
  console.error(error);
});

// maybeh?
// process.on('unhandledRejection', err => {
//   console.warn(`Uncaught Promise Error: \n${err.stack}`)
// });

client.dispatcher.addInhibitor((message) => {
  if (!message.command || !message.command.group) {
    return false;
  }

  // Only let ThaSauce & Compo Admins run compoverse commands
  if (message.command.group.id === 'compoverse') {
    let authorized = memberHasOneOfTheseRoles(message.member, [
      roleIds.thasauceAdmin,
      roleIds.compoAdmin,
    ]);
    if (!authorized) {
      return {
        reason: 'not-allowed',
        response: message.reply("you're not allowed to run compoverse commands"),
      };
    }
  }

  // TODO: Experiment with enabled an owner-only dev mode when running locally
  // Maybe this should use NODE_ENV?
  // if (!client.isOwner(message.author) && process.env.DEV_MODE == 'true') {
  //   return ['dev-mode', message.reply('I\'m currently in development mode and not currently accepting commands')];
  // }
});

process.on('SIGINT', function () {
  console.log(`Shutting down in ${process.env.NODE_ENV} environment...`);

  // Integrate this with the logger machine/server in lib/logger.js
  client.channels
    .fetch(fetchEnv('DEBUG_CHANNEL_ID'))
    .then((debugChannel) => {
      return debugChannel.send(
        `\`\`\`Shutting down in ${process.env.NODE_ENV} environment...\`\`\``
      );
    })
    .then(() => {
      process.exit();
    })
    .catch((e) => {
      console.log('There was an error sending the shut down message: ', e);
      process.exit();
    });
});

client.login(fetchEnv('HUBOT_DISCORD_TOKEN'));
