import { AllFlowsPrecondition } from '@sapphire/framework';
import type { CommandInteraction, GuildMember } from 'discord.js';

import { memberHasOneOfTheseRoles, roleIds } from '../utils/roles';

export class CompoAdminOnly extends AllFlowsPrecondition {
  public override async chatInputRun(interaction: CommandInteraction) {
    return this.checkMember(interaction);
  }

  // Message commands are not used (slash-only), but AllFlowsPrecondition requires this.
  public override async messageRun() {
    return this.error({ message: 'Message commands are not supported.' });
  }

  public override async contextMenuRun() {
    return this.error({ message: 'Context menu commands are not supported.' });
  }

  private async checkMember(interaction: CommandInteraction) {
    const member = (interaction.guild?.members.cache.get(interaction.user.id) ??
      (await interaction.guild?.members.fetch(interaction.user.id))) as GuildMember | undefined;

    const authorized =
      member != null &&
      memberHasOneOfTheseRoles(member, [roleIds.thasauceAdmin, roleIds.compoAdmin]);

    return authorized
      ? this.ok()
      : this.error({ message: "you're not allowed to run compoverse commands" });
  }
}

// Augment Sapphire's Preconditions interface so TypeScript knows 'CompoAdminOnly' is valid.
declare module '@sapphire/framework' {
  interface Preconditions {
    CompoAdminOnly: never;
  }
}
