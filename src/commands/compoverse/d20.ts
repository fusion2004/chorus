import { randomInt } from 'node:crypto';

import { Command } from '@sapphire/framework';
import { EmbedBuilder } from 'discord.js';

const NAT_1_POOL = [
  'The die rolls off the table, into the abyss. You feel a chill.',
  'Critical miss. Chorus looks away, disappointed.',
  "Your entry gets DQ'd before the round even starts.",
  'The master bus clips. Everyone winces.',
] as const;

const POOL_2_5 = [
  'Ouch. Might want to rework the mix.',
  'The judges exchange glances. Not the good kind.',
  "That one's going last in the playlist.",
  'Your sidechain was too aggressive.',
] as const;

const POOL_6_10 = [
  'The die shrugs. The mixer hums.',
  "Mid-tier. You'll finish somewhere in the middle of the pack.",
  'Not bad, not great. Chorus gives a non-committal shrug.',
] as const;

const POOL_11_15 = [
  'Solid. A respectable showing for the round.',
  "The crowd bobs their heads. That's a good sign.",
  'You held your ground. Top half, maybe.',
] as const;

const POOL_16_19 = [
  'Nice. Very nice. The comments channel lights up.',
  'The sub-bass rumbles approvingly.',
  'Your levels are dialed in. Chorus nods approvingly.',
] as const;

const NAT_20_POOL = [
  'NATURAL 20! The crowd goes wild!',
  'Perfect roll. Your track just won the compo and nobody even heard it yet.',
  'The sidechain is immaculate. The mix is transcendent. Chorus weeps.',
] as const;

export interface Bucket {
  color: number;
  emoji: string;
  pool: readonly string[];
}

export function rollD20(): number {
  return randomInt(1, 21);
}

export function bucketFor(roll: number): Bucket {
  if (roll === 1) return { color: 0xb71c1c, emoji: '💀', pool: NAT_1_POOL };
  if (roll <= 5) return { color: 0xef6c00, emoji: '😬', pool: POOL_2_5 };
  if (roll <= 10) return { color: 0x9e9e9e, emoji: '😐', pool: POOL_6_10 };
  if (roll <= 15) return { color: 0x1976d2, emoji: '🙂', pool: POOL_11_15 };
  if (roll <= 19) return { color: 0x2e7d32, emoji: '😎', pool: POOL_16_19 };
  return { color: 0xffd700, emoji: '🎉', pool: NAT_20_POOL };
}

export function pickLine(pool: readonly string[]): string {
  return pool[randomInt(pool.length)];
}

export class D20Command extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      cooldownDelay: 30_000,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder.setName('d20').setDescription('Roll a d20'),
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction,
  ): Promise<void> {
    const roll = rollD20();
    const bucket = bucketFor(roll);
    const flavor = pickLine(bucket.pool);

    const embed = new EmbedBuilder()
      .setColor(bucket.color)
      .setTitle(`${bucket.emoji} d20`)
      .setDescription(`${interaction.user.toString()} rolled a **${roll}**\n\n*${flavor}*`);

    await interaction.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  }
}
