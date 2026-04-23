import { Precondition } from '@sapphire/framework';
import type { CommandInteraction, GuildMember } from 'discord.js';

import { memberHasOneOfTheseRoles, roleIds } from '../utils/roles.js';

export function isCompoAdmin(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  return memberHasOneOfTheseRoles(member, [roleIds.thasauceAdmin, roleIds.compoAdmin]);
}

export class CompoAdminOnly extends Precondition {
  public override async chatInputRun(interaction: CommandInteraction) {
    return this.checkMember(interaction);
  }

  private async checkMember(interaction: CommandInteraction) {
    const member = (interaction.guild?.members.cache.get(interaction.user.id) ??
      (await interaction.guild?.members.fetch(interaction.user.id))) as GuildMember | undefined;

    return isCompoAdmin(member)
      ? this.ok()
      : this.error({
          message:
            'You must have either the Compo Organizer or ThaSauce Admin role to run this command.',
        });
  }
}

// Augment Sapphire's Preconditions interface so TypeScript knows 'CompoAdminOnly' is valid.
declare module '@sapphire/framework' {
  interface Preconditions {
    CompoAdminOnly: never;
  }
}
