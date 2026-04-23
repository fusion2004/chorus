import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { VoteJarskiCommand } from './votejarski.js';
import { CompoAdminOnly } from '../../preconditions/CompoAdminOnly.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { registerForTest } from '../../__test_helpers__/sapphire.js';
import { runCommand } from '../../__test_helpers__/run-command.js';

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
