require('dotenv').config();

import { SapphireClient, ApplicationCommandRegistries, RegisterBehavior } from '@sapphire/framework';
import { GatewayIntentBits, TextChannel } from 'discord.js';

import { fetchEnv } from './utils/fetch-env';

ApplicationCommandRegistries.setDefaultGuildIds([fetchEnv('GUILD_ID')]);
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

const client = new SapphireClient({
  intents: [GatewayIntentBits.Guilds],
  defaultPrefix: null,
});

client.on('error', console.error);

process.on('SIGINT', function () {
  console.log(`Shutting down in ${process.env.NODE_ENV} environment...`);

  client.channels
    .fetch(fetchEnv('DEBUG_CHANNEL_ID'))
    .then((debugChannel) => {
      return (debugChannel as TextChannel).send(
        `\`\`\`Shutting down in ${process.env.NODE_ENV} environment...\`\`\``
      );
    })
    .then(() => {
      process.exit();
    })
    .catch((e: Error) => {
      console.log('There was an error sending the shut down message: ', e);
      process.exit();
    });
});

client.login(fetchEnv('HUBOT_DISCORD_TOKEN'));
