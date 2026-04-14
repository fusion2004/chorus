import { Command } from '@sapphire/framework';
import type { TextChannel } from 'discord.js';

import { partyService } from '../../lib/party';

export class RefetchPartyCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ['CompoAdminOnly'] });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('refetchparty')
        .setDescription('Refetches the round for the current listening party (loads new entries)'),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    if (partyService.getSnapshot().matches('idle')) {
      await interaction.reply({
        content: 'there is no listening party, currently!',
        ephemeral: true,
      });
      return;
    }

    if (!partyService.getSnapshot().matches({ partying: { processing: 'idle' } })) {
      await interaction.reply({
        content: 'there is already a fetch or refetch running!',
        ephemeral: true,
      });
      return;
    }

    partyService.send({ type: 'REFETCH', channel: interaction.channel as TextChannel });
    await interaction.reply({ content: 'Refetching round...' });
  }
}
