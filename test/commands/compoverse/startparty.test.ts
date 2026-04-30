import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@src/lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
    send: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { StartPartyCommand } from '@src/commands/compoverse/startparty.js';
import { CompoAdminOnly } from '@src/preconditions/CompoAdminOnly.js';
import { partyService } from '@src/lib/party.js';
import { logger, debugChannelService } from '@src/lib/logger.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

describe('StartPartyCommand', () => {
  let command: StartPartyCommand;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'startparty', piece: StartPartyCommand },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy = vi.spyOn(logger, 'info');
    warnSpy = vi.spyOn(logger, 'warn');
    sendSpy = vi.spyOn(debugChannelService, 'send');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ round: 'OHC123' }),
        'Attempted to start a listening party while one is already running',
      );
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'SEND_MESSAGE',
        message: expect.stringMatching(
          /^WARN: Attempted to start a listening party while one is already running · .*round=OHC123/,
        ),
      });
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
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ round: 'OHC123' }),
        'Starting a listening party',
      );
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'SEND_MESSAGE',
        message: expect.stringMatching(/^INFO: Starting a listening party · .*round=OHC123/),
      });
    });
  });
});
