import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { VoteJarskiCommand } from '@src/commands/compoverse/votejarski.js';
import { makeMockInteraction } from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

describe('VoteJarskiCommand', () => {
  let command: VoteJarskiCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [],
      command: { name: 'votejarski', piece: VoteJarskiCommand },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers with the name "votejarski"', () => {
    expect(command.name).toBe('votejarski');
  });

  it('has a 60-second cooldown', () => {
    expect(command.options.cooldownDelay).toBe(60_000);
  });

  it('wires no application-level preconditions', () => {
    const names = command.preconditions.entries.map((e: any) => e.name);
    expect(names).not.toContain('CompoAdminOnly');
  });

  it('replies with the Jarski reminder (not ephemeral)', async () => {
    const interaction = makeMockInteraction({ userId: 'votejarski-reminder' });
    const res = await runCommand(command, interaction);
    expect(res.ran).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: '### Remember to always vote Jarski #1',
    });
  });
});
