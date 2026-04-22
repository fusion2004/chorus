import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@sapphire/framework', async (importActual) => {
  const actual = await importActual<typeof import('@sapphire/framework')>();
  class MockCommand {
    options: any;
    constructor(_ctx: any, options: any) {
      this.options = options;
    }
    registerApplicationCommands() {}
  }
  return { ...actual, Command: MockCommand };
});

import { VoteJarskiCommand } from './votejarski.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../../__test_helpers__/precondition.js';

describe('VoteJarskiCommand', () => {
  let command: VoteJarskiCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new VoteJarskiCommand({} as any, {} as any);
  });

  it('wires the CompoAdminOnly precondition', () => {
    expect((command as any).options.preconditions).toContain('CompoAdminOnly');
  });

  describe('authorization', () => {
    it('allows an admin member', async () => {
      expect((await runCompoAdminOnly(makeAdminInteraction())).isOk()).toBe(true);
    });
    it('blocks a non-admin member', async () => {
      expect((await runCompoAdminOnly(makeNonAdminInteraction())).isErr()).toBe(true);
    });
    it('blocks when the member cannot be resolved', async () => {
      expect((await runCompoAdminOnly(makeMissingMemberInteraction())).isErr()).toBe(true);
    });
  });

  it('replies with the Jarski reminder (not ephemeral)', async () => {
    const interaction = makeAdminInteraction();
    await command.chatInputRun(interaction as any);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Remember to always vote Jarski #1',
    });
  });
});
