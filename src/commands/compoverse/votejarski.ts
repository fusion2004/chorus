import { Command } from '@sapphire/framework';

export class VoteJarskiCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      cooldownDelay: 60_000, // 60 seconds
    });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder.setName('votejarski').setDescription('Remember to vote Jarski'),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.reply({ content: '### Remember to always vote Jarski #1' });
  }
}
