import {
  SapphireClient,
  ApplicationCommandRegistries,
  RegisterBehavior,
} from '@sapphire/framework';
import { GatewayIntentBits, TextChannel } from 'discord.js';

import { logger, debugText, sendMessages } from './lib/logger.js';
import { sapphireLogger } from './lib/sapphire-logger.js';
import { fetchEnv, fetchEnvironment } from './utils/fetch-env.js';

ApplicationCommandRegistries.setDefaultGuildIds([fetchEnv('GUILD_ID')]);
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

const client = new SapphireClient({
  intents: [GatewayIntentBits.Guilds],
  defaultPrefix: null,
  baseUserDirectory: import.meta.dirname,
  logger: { instance: sapphireLogger },
});

client.on('error', (err) => logger.error(err));

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ env: fetchEnvironment() }, 'Shutting down...');

  // TODO: immediately shutdown the party machine

  client.channels
    .fetch(fetchEnv('DEBUG_CHANNEL_ID'))
    .then((debugChannel) => {
      const message = debugText({ env: fetchEnvironment() }, 'Shutting down...');
      return sendMessages(debugChannel as TextChannel, [message]);
    })
    .then(() => {
      process.exit();
    })
    .catch((e: Error) => {
      logger.error(e);
      process.exit();
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(fetchEnv('HUBOT_DISCORD_TOKEN'));
