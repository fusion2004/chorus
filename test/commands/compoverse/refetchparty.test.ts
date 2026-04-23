import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('@src/lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
    send: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { RefetchPartyCommand } from '@src/commands/compoverse/refetchparty.js';
import { CompoAdminOnly } from '@src/preconditions/CompoAdminOnly.js';
import { partyService } from '@src/lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

function matchesOnly(states: Array<string | Record<string, any>>) {
  return (state: string | Record<string, any>) => {
    const key = JSON.stringify(state);
    return states.some((s) => JSON.stringify(s) === key);
  };
}

describe('RefetchPartyCommand', () => {
  let command: RefetchPartyCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'refetchparty', piece: RefetchPartyCommand },
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
    });

    it('blocks a non-admin member', async () => {
      const res = await runCommand(command, makeNonAdminInteraction());
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
      (partyService.getSnapshot as any).mockReturnValue({ matches: matchesOnly(['idle']) });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'there is no listening party, currently!',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('replies ephemerally when a fetch or refetch is already running', async () => {
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'there is already a fetch or refetch running!',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('sends REFETCH and replies when processing is idle', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: matchesOnly([{ partying: { processing: 'idle' } }]),
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).toHaveBeenCalledWith({
        type: 'REFETCH',
        channel: interaction.channel,
      });
      expect(interaction.reply).toHaveBeenCalledWith({ content: 'Refetching round...' });
    });
  });
});
