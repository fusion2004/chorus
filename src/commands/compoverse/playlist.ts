import { Command } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';

import { partyService } from '../../lib/party';

export class PlaylistCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ['CompoAdminOnly'] });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('playlist')
        .setDescription(
          'Lists all songs in the listening party, highlighting the current position',
        ),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    const { currentSong, nextSongId, songs } = partyService.getSnapshot().context;

    if (partyService.getSnapshot().matches('idle')) {
      await interaction.reply({
        content: 'there is no listening party, currently!',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!songs || songs.length === 0) {
      await interaction.reply({
        content: "there aren't any songs fetched in the listening party, yet!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let msg = '';
    songs.forEach((song: any, index: number) => {
      if (currentSong && currentSong.id === song.id) {
        msg = msg.concat(':arrow_forward: ');
      }
      if (nextSongId && nextSongId === song.id) {
        msg = msg.concat(':track_next: ');
      }
      msg = msg.concat(`${index + 1}. ${song.safeTitle} [`);
      if (song.formattedDuration) {
        msg = msg.concat(`length: ${song.formattedDuration}, `);
      }
      msg = msg.concat(`state: ${String(song.service.getSnapshot().value)}]`);
      msg = msg.concat('\n');
    });

    await interaction.reply({ content: msg });
  }
}
