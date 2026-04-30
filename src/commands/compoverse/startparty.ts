import { Command } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';
import type { TextChannel } from 'discord.js';

import { partyService } from '../../lib/party.js';
import { debugInfo, debugWarn } from '../../lib/logger.js';

export class StartPartyCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ['CompoAdminOnly'] });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('startparty')
        .setDescription('Starts a listening party for a Compo round')
        .addStringOption((option) =>
          option
            .setName('round')
            .setDescription('Round ID to start a party for (e.g. OHC123, 2HTS45)')
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('initial_song_index')
            .setDescription('Index of the song to start on (default: 0)')
            .setRequired(false),
        ),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    const round = interaction.options.getString('round', true).toUpperCase();
    const meta = {
      round,
      user: interaction.member.user.username,
      userMention: interaction.member.user.toString(),
      guild: interaction.guild?.name,
      channel: interaction.channel.name,
      channelMention: interaction.channel.toString(),
    };
    if (partyService.getSnapshot().matches('partying')) {
      debugWarn(meta, 'Attempted to start a listening party while one is already running');
      await interaction.reply({
        content:
          'there is currently a listening party streaming. We can only stream one at a time.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    debugInfo(meta, 'Starting a listening party');
    partyService.send({
      type: 'START',
      channel: interaction.channel as TextChannel,
      round,
    });
    await interaction.reply({
      content: `Starting listening party for ${round}...`,
    });
  }
}
