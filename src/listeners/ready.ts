import { Listener } from '@sapphire/framework';
import { Events, Client, TextChannel } from 'discord.js';

import { log, setDebugChannel } from '../lib/logger.js';
import { fetchEnv, fetchEnvironment } from '../utils/fetch-env.js';

export class ReadyListener extends Listener<typeof Events.ClientReady> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ClientReady, once: true });
  }

  public async run(client: Client<true>): Promise<void> {
    const debugChannel = await client.channels.fetch(fetchEnv('DEBUG_CHANNEL_ID'));
    setDebugChannel(debugChannel as TextChannel);
    log(`Booted up in ${fetchEnvironment()} environment!`);
    log(`Logged in as ${client.user.tag}! (${client.user.id})`);
  }
}
