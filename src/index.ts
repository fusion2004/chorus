import {
  SapphireClient,
  ApplicationCommandRegistries,
  RegisterBehavior,
} from '@sapphire/framework';
import { GatewayIntentBits, TextChannel } from 'discord.js';

import { fetchEnv, fetchEnvironment } from './utils/fetch-env.js';

ApplicationCommandRegistries.setDefaultGuildIds([fetchEnv('GUILD_ID')]);
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

const client = new SapphireClient({
  intents: [GatewayIntentBits.Guilds],
  defaultPrefix: null,
  baseUserDirectory: import.meta.dirname,
});

client.on('error', console.error);

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Shutting down in ${fetchEnvironment()} environment...`);

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
      console.log('There was an error sending the shut down message: ', e);
      process.exit();
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(fetchEnv('HUBOT_DISCORD_TOKEN'));
