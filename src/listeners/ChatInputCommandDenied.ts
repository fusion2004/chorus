import {
  Events,
  Listener,
  type ChatInputCommandDeniedPayload,
  type UserError,
} from '@sapphire/framework';
import { MessageFlags } from 'discord.js';

export class ChatInputCommandDenied extends Listener<typeof Events.ChatInputCommandDenied> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ChatInputCommandDenied });
  }

  public run(error: UserError, { interaction }: ChatInputCommandDeniedPayload) {
    const isSilent = Reflect.get(Object(error.context), 'silent');

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({
        content: isSilent ? '\u200b' : error.message,
      });
    }

    return interaction.reply({
      content: isSilent ? '\u200b' : error.message,
      flags: MessageFlags.Ephemeral,
    });
  }
}
