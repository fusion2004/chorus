import { Command } from '@sapphire/framework';

import { partyService } from '../../lib/party';

export class SkipSongCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ['CompoAdminOnly'] });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('skipsong')
        .setDescription('Skips the currently playing song and starts the next one'),
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

    if (partyService.getSnapshot().matches({ partying: { streaming: 'idle' } })) {
      await interaction.reply({
        content: "the listening party isn't skippable yet!",
        ephemeral: true,
      });
      return;
    }

    partyService.send({ type: 'SKIP_SONG' });
    await interaction.reply({ content: 'Skipping current song...' });
  }
}
