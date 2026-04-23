import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../../src/lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
    send: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { SkipSongCommand } from '../../../src/commands/compoverse/skipsong.js';
import { CompoAdminOnly } from '../../../src/preconditions/CompoAdminOnly.js';
import { partyService } from '../../../src/lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../helpers/interaction.js';
import { registerForTest } from '../../helpers/sapphire.js';
import { runCommand } from '../../helpers/run-command.js';

function matchesOnly(states: Array<string | Record<string, any>>) {
  return (state: string | Record<string, any>) => {
    const key = JSON.stringify(state);
    return states.some((s) => JSON.stringify(s) === key);
  };
}

describe('SkipSongCommand', () => {
  let command: SkipSongCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'skipsong', piece: SkipSongCommand },
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

    it('replies ephemerally when streaming is idle (not skippable yet)', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: matchesOnly([{ partying: { streaming: 'idle' } }]),
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: "the listening party isn't skippable yet!",
        flags: MessageFlags.Ephemeral,
      });
    });

    it('sends SKIP_SONG and replies when streaming is active', async () => {
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(partyService.send).toHaveBeenCalledWith({ type: 'SKIP_SONG' });
      expect(interaction.reply).toHaveBeenCalledWith({ content: 'Skipping current song...' });
    });
  });
});
