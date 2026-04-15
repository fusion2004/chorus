import { Command } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';

import { partyService } from '../../lib/party';

export class StopPartyCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ['CompoAdminOnly'] });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder.setName('stopparty').setDescription('Stops any current listening party'),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    if (partyService.getSnapshot().matches('idle')) {
      await interaction.reply({
        content: 'there is no listening party to stop!',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    partyService.send({ type: 'STOP', immediate: true });
    await interaction.reply({ content: 'Stopping the listening party...' });
  }
}
