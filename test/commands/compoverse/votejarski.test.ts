import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { VoteJarskiCommand } from '@src/commands/compoverse/votejarski.js';
import { CompoAdminOnly } from '@src/preconditions/CompoAdminOnly.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

describe('VoteJarskiCommand', () => {
  let command: VoteJarskiCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'votejarski', piece: VoteJarskiCommand },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires the CompoAdminOnly precondition', () => {
    const names = command.preconditions.entries.map((e: any) => e.name);
    expect(names).toContain('CompoAdminOnly');
  });

  describe('authorization', () => {
    it('allows an admin member', async () => {
      const res = await runCommand(command, makeAdminInteraction());
      expect(res.ran).toBe(true);
    });

    it('blocks a non-admin member', async () => {
      const res = await runCommand(command, makeNonAdminInteraction());
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
    });

    it('blocks when the guild member cannot be resolved', async () => {
      const res = await runCommand(command, makeMissingMemberInteraction());
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
    });
  });

  it('replies with the Jarski reminder (not ephemeral)', async () => {
    const interaction = makeAdminInteraction();
    const res = await runCommand(command, interaction);
    expect(res.ran).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Remember to always vote Jarski #1',
    });
  });
});
