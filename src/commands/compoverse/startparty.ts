import { Command } from '@sapphire/framework';

import { partyService } from '../../lib/party';

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
            .setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName('initial_song_index')
            .setDescription('Index of the song to start on (default: 0)')
            .setRequired(false)
        )
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction
  ): Promise<void> {
    if (partyService.state.matches('partying')) {
      await interaction.reply({
        content: 'there is currently a listening party streaming. We can only stream one at a time.',
        ephemeral: true,
      });
      return;
    }

    const round = interaction.options.getString('round', true).toUpperCase();
    partyService.send({ type: 'START', channel: interaction.channel, round });
    await interaction.reply({ content: `Starting listening party for ${round}...` });
  }
}
