import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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
import { CompoAdminOnly } from '../../preconditions/CompoAdminOnly.js';
import { partyService } from '../../lib/party.js';
import { log } from '../../lib/logger.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { registerForTest } from '../../__test_helpers__/sapphire.js';
import { runCommand } from '../../__test_helpers__/run-command.js';

describe('StartPartyCommand', () => {
  let command: StartPartyCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'startparty', piece: StartPartyCommand },
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
    it('allows an admin member to reach chatInputRun', async () => {
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const interaction = makeAdminInteraction({ options: { round: 'ohc123' } });
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(true);
      expect(res.blockedBy).toBeNull();
      expect(partyService.send).toHaveBeenCalled();
    });

    it('blocks a non-admin member before chatInputRun', async () => {
      const interaction = makeNonAdminInteraction({ options: { round: 'ohc123' } });
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('blocks when the guild member cannot be resolved', async () => {
      const interaction = makeMissingMemberInteraction({ options: { round: 'ohc123' } });
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
      expect(partyService.send).not.toHaveBeenCalled();
    });
  });

  describe('chatInputRun', () => {
    it('refuses to start when a party is already running', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state === 'partying',
      });
      const interaction = makeAdminInteraction({ options: { round: 'ohc123' } });

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
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

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
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
