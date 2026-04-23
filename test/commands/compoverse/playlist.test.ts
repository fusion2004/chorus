import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('@src/lib/party.js', () => ({
  partyService: {
    getSnapshot: vi.fn(),
  },
}));

import { MessageFlags } from 'discord.js';
import { PlaylistCommand } from '@src/commands/compoverse/playlist.js';
import { CompoAdminOnly } from '@src/preconditions/CompoAdminOnly.js';
import { partyService } from '@src/lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '@test/helpers/interaction.js';
import { registerForTest } from '@test/helpers/sapphire.js';
import { runCommand } from '@test/helpers/run-command.js';

function makeSong(overrides: {
  id: string;
  safeTitle: string;
  formattedDuration?: string | null;
  state?: string;
}) {
  return {
    id: overrides.id,
    safeTitle: overrides.safeTitle,
    formattedDuration: overrides.formattedDuration ?? null,
    service: {
      getSnapshot: () => ({ value: overrides.state ?? 'ready' }),
    },
  };
}

describe('PlaylistCommand', () => {
  let command: PlaylistCommand;

  beforeAll(async () => {
    command = await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'playlist', piece: PlaylistCommand },
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
      (partyService.getSnapshot as any).mockReturnValue({
        context: { currentSong: undefined, nextSongId: undefined, songs: [] },
        matches: () => false,
      });
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

  describe('chatInputRun', () => {
    it('replies ephemerally when idle', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        context: { currentSong: undefined, nextSongId: undefined, songs: undefined },
        matches: (state: string) => state === 'idle',
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'there is no listening party, currently!',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('replies ephemerally when not idle but songs is empty', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        context: { currentSong: undefined, nextSongId: undefined, songs: [] },
        matches: () => false,
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(interaction.reply).toHaveBeenCalledWith({
        content: "there aren't any songs fetched in the listening party, yet!",
        flags: MessageFlags.Ephemeral,
      });
    });

    it('builds the playlist with current/next markers, durations, and per-song state', async () => {
      const songs = [
        makeSong({ id: 'a', safeTitle: 'Alpha', formattedDuration: '1:00', state: 'ready' }),
        makeSong({ id: 'b', safeTitle: 'Beta', formattedDuration: '2:30', state: 'transcoded' }),
        makeSong({ id: 'c', safeTitle: 'Gamma', state: 'downloading' }),
      ];
      (partyService.getSnapshot as any).mockReturnValue({
        context: { currentSong: songs[0], nextSongId: 'b', songs },
        matches: () => false,
      });
      const interaction = makeAdminInteraction();

      const res = await runCommand(command, interaction);

      expect(res.ran).toBe(true);
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const replyArg = (interaction.reply as any).mock.calls[0][0];
      expect(replyArg.content).toBe(
        ':arrow_forward: 1. Alpha [length: 1:00, state: ready]\n' +
          ':track_next: 2. Beta [length: 2:30, state: transcoded]\n' +
          '3. Gamma [state: downloading]\n',
      );
      expect(replyArg.flags).toBeUndefined();
    });
  });
});
