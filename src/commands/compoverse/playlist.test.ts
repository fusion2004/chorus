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
  },
}));

import { MessageFlags } from 'discord.js';
import { PlaylistCommand } from './playlist.js';
import { partyService } from '../../lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../../__test_helpers__/precondition.js';

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

  beforeEach(() => {
    vi.clearAllMocks();
    command = new PlaylistCommand({} as any, {} as any);
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
        context: { currentSong: undefined, nextSongId: undefined, songs: undefined },
        matches: (state: string) => state === 'idle',
      });
      const interaction = makeAdminInteraction();
      await command.chatInputRun(interaction as any);
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
      await command.chatInputRun(interaction as any);
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
      await command.chatInputRun(interaction as any);

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
