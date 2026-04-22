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

vi.mock('../../lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
    send: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { StopPartyCommand } from './stopparty.js';
import { partyService } from '../../lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../../__test_helpers__/precondition.js';

describe('StopPartyCommand', () => {
  let command: StopPartyCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new StopPartyCommand({} as any, {} as any);
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

  describe('chatInputRun', () => {
    it('replies ephemerally when idle', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state === 'idle',
      });
      const interaction = makeAdminInteraction();

      await command.chatInputRun(interaction as any);

      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'there is no listening party to stop!',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('sends STOP with immediate:true and replies when a party is running', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state !== 'idle',
      });
      const interaction = makeAdminInteraction();

      await command.chatInputRun(interaction as any);

      expect(partyService.send).toHaveBeenCalledWith({ type: 'STOP', immediate: true });
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'Stopping the listening party...',
      });
    });
  });
});
