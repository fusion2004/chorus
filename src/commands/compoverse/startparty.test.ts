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

vi.mock('../../lib/logger.js', () => ({
  log: vi.fn(),
  setDebugChannel: vi.fn(),
}));

import { MessageFlags } from 'discord.js';
import { StartPartyCommand } from './startparty.js';
import { partyService } from '../../lib/party.js';
import { log } from '../../lib/logger.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../../__test_helpers__/precondition.js';

describe('StartPartyCommand', () => {
  let command: StartPartyCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new StartPartyCommand({} as any, {} as any);
  });

  it('wires the CompoAdminOnly precondition', () => {
    expect((command as any).options.preconditions).toContain('CompoAdminOnly');
  });

  describe('authorization', () => {
    it('allows an admin member', async () => {
      const result = await runCompoAdminOnly(makeAdminInteraction());
      expect(result.isOk()).toBe(true);
    });

    it('blocks a non-admin member', async () => {
      const result = await runCompoAdminOnly(makeNonAdminInteraction());
      expect(result.isErr()).toBe(true);
    });

    it('blocks when the member cannot be resolved', async () => {
      const result = await runCompoAdminOnly(makeMissingMemberInteraction());
      expect(result.isErr()).toBe(true);
    });
  });

  describe('chatInputRun', () => {
    it('refuses to start when a party is already running', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state === 'partying',
      });
      const interaction = makeAdminInteraction({ options: { round: 'ohc123' } });

      await command.chatInputRun(interaction as any);

      expect(partyService.send).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect((log as any).mock.calls[0][0]).toContain('Attempted to start a listening party');
      expect(interaction.reply).toHaveBeenCalledWith({
        content:
          'there is currently a listening party streaming. We can only stream one at a time.',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('starts a party, uppercases the round, sends START, replies, and logs', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state !== 'partying',
      });
      const interaction = makeAdminInteraction({ options: { round: 'ohc123' } });

      await command.chatInputRun(interaction as any);

      expect(partyService.send).toHaveBeenCalledTimes(1);
      expect(partyService.send).toHaveBeenCalledWith({
        type: 'START',
        channel: interaction.channel,
        round: 'OHC123',
      });
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'Starting listening party for OHC123...',
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect((log as any).mock.calls[0][0]).toContain('Starting a listening party for OHC123');
    });
  });
});
