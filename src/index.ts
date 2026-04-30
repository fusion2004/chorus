import {
  SapphireClient,
  ApplicationCommandRegistries,
  RegisterBehavior,
} from '@sapphire/framework';
import { GatewayIntentBits, TextChannel } from 'discord.js';

import { logger } from './lib/logger.js';
import { fetchEnv, fetchEnvironment } from './utils/fetch-env.js';

ApplicationCommandRegistries.setDefaultGuildIds([fetchEnv('GUILD_ID')]);
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

const client = new SapphireClient({
  intents: [GatewayIntentBits.Guilds],
  defaultPrefix: null,
  baseUserDirectory: import.meta.dirname,
});

client.on('error', (err) => logger.error(err));

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ env: fetchEnvironment() }, 'Shutting down');

  // TODO: immediately shutdown the party machine

  client.channels
    .fetch(fetchEnv('DEBUG_CHANNEL_ID'))
    .then((debugChannel) => {
      return (debugChannel as TextChannel).send(
        `> Shutting down in \`${fetchEnvironment()}\` environment...`,
      );
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
