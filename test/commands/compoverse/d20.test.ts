import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomInt } from 'node:crypto';

import { D20Command, rollD20, bucketFor, pickLine } from '@src/commands/compoverse/d20.js';
import { makeMockInteraction } from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

type RandomIntSync = ((max: number) => number) & ((min: number, max: number) => number);
type RandomIntMock = ReturnType<typeof vi.fn<RandomIntSync>>;

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn<RandomIntSync>() };
});

const mockedRandomInt = randomInt as unknown as RandomIntMock;

describe('D20Command', () => {
  let command: D20Command;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [],
      command: { name: 'd20', piece: D20Command },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers with the name "d20"', () => {
    expect(command.name).toBe('d20');
  });

  it('has a 30-second cooldown', () => {
    expect(command.options.cooldownDelay).toBe(30_000);
  });

  it('wires no application-level preconditions (only the framework Cooldown)', () => {
    const names = command.preconditions.entries.map((e: any) => e.name);
    expect(names).not.toContain('CompoAdminOnly');
  });

  describe('rollD20', () => {
    it('returns 1 when randomInt returns 1', () => {
      mockedRandomInt.mockReturnValueOnce(1);
      expect(rollD20()).toBe(1);
      expect(mockedRandomInt).toHaveBeenCalledWith(1, 21);
    });

    it('returns 20 when randomInt returns 20', () => {
      mockedRandomInt.mockReturnValueOnce(20);
      expect(rollD20()).toBe(20);
      expect(mockedRandomInt).toHaveBeenCalledWith(1, 21);
    });
  });

  describe('pickLine', () => {
    const pool = ['a', 'b', 'c'] as const;

    it('returns the first element when randomInt returns 0', () => {
      mockedRandomInt.mockReturnValueOnce(0);
      expect(pickLine(pool)).toBe('a');
      expect(mockedRandomInt).toHaveBeenCalledWith(3);
    });

    it('returns the last element when randomInt returns pool.length - 1', () => {
      mockedRandomInt.mockReturnValueOnce(2);
      expect(pickLine(pool)).toBe('c');
      expect(mockedRandomInt).toHaveBeenCalledWith(3);
    });
  });

  describe('bucketFor', () => {
    it('maps roll 1 to the nat-1 bucket (red, 💀)', () => {
      const bucket = bucketFor(1);
      expect(bucket.color).toBe(0xb71c1c);
      expect(bucket.emoji).toBe('💀');
      expect(bucket.pool[0]).toContain('abyss');
    });

    it('maps roll 20 to the nat-20 bucket (gold, 🎉)', () => {
      const bucket = bucketFor(20);
      expect(bucket.color).toBe(0xffd700);
      expect(bucket.emoji).toBe('🎉');
      expect(bucket.pool[0]).toContain('NATURAL 20');
    });

    it('maps roll 8 to the 6–10 bucket (grey, 😐)', () => {
      const bucket = bucketFor(8);
      expect(bucket.color).toBe(0x9e9e9e);
      expect(bucket.emoji).toBe('😐');
      expect(bucket.pool).toContain('The die shrugs. The mixer hums.');
    });

    it('maps boundary rolls (2, 5, 6, 10, 11, 15, 16, 19) to the correct buckets', () => {
      expect(bucketFor(2).emoji).toBe('😬');
      expect(bucketFor(5).emoji).toBe('😬');
      expect(bucketFor(6).emoji).toBe('😐');
      expect(bucketFor(10).emoji).toBe('😐');
      expect(bucketFor(11).emoji).toBe('🙂');
      expect(bucketFor(15).emoji).toBe('🙂');
      expect(bucketFor(16).emoji).toBe('😎');
      expect(bucketFor(19).emoji).toBe('😎');
    });
  });

  describe('chatInputRun (end-to-end)', () => {
    // Each test uses a distinct userId so the Sapphire cooldown bucket is
    // per-user — otherwise the 30s cooldown from one test denies the next.
    it('replies with an embed matching the pinned roll and flavor', async () => {
      // First randomInt call = rollD20 (returns 1). Second = pickLine index 0.
      mockedRandomInt.mockReturnValueOnce(1).mockReturnValueOnce(0);

      const interaction = makeMockInteraction({ userId: 'roller-nat1' });
      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(interaction.reply).toHaveBeenCalledTimes(1);

      const call = interaction.reply.mock.calls[0][0];
      const embed = call.embeds[0];
      const data = embed.toJSON();

      expect(data.color).toBe(0xb71c1c);
      expect(data.title).toBe('💀 d20');
      expect(data.description).toContain('<@roller-nat1>');
      expect(data.description).toContain('rolled a **1**');
      expect(data.description).toContain(
        'The die rolls off the table, into the abyss. You feel a chill.',
      );
    });

    it('sends a public reply with allowedMentions suppressed and no Ephemeral flag', async () => {
      mockedRandomInt.mockReturnValueOnce(15).mockReturnValueOnce(0);

      const interaction = makeMockInteraction({ userId: 'roller-mid' });
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(true);

      const call = interaction.reply.mock.calls[0][0];
      expect(call.allowedMentions).toEqual({ parse: [] });
      expect(call.flags).toBeUndefined();
    });

    it('uses the nat-20 bucket for a roll of 20', async () => {
      mockedRandomInt.mockReturnValueOnce(20).mockReturnValueOnce(0);

      const interaction = makeMockInteraction({ userId: 'roller-nat20' });
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(true);

      const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.color).toBe(0xffd700);
      expect(embed.title).toBe('🎉 d20');
      expect(embed.description).toContain('rolled a **20**');
    });
  });
});
