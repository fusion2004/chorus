import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('@src/lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
    send: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { StopPartyCommand } from '@src/commands/compoverse/stopparty.js';
import { CompoAdminOnly } from '@src/preconditions/CompoAdminOnly.js';
import { partyService } from '@src/lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

describe('StopPartyCommand', () => {
  let command: StopPartyCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'stopparty', piece: StopPartyCommand },
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
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const res = await runCommand(command, makeAdminInteraction());
      expect(res.ran).toBe(true);
      expect(res.blockedBy).toBeNull();
    });

    it('blocks a non-admin member', async () => {
      const interaction = makeNonAdminInteraction();
      const res = await runCommand(command, interaction);
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
      expect(partyService.send).not.toHaveBeenCalled();
    });

    it('blocks when the guild member cannot be resolved', async () => {
      const res = await runCommand(command, makeMissingMemberInteraction());
      expect(res.ran).toBe(false);
      expect(res.blockedBy).toBe('CompoAdminOnly');
    });
  });

  describe('chatInputRun', () => {
    it('replies ephemerally when idle', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: (state: string) => state === 'idle',
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
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

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).toHaveBeenCalledWith({ type: 'STOP', immediate: true });
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'Stopping the listening party...',
      });
    });
  });
});
