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
import { SkipSongCommand } from './skipsong.js';
import { partyService } from '../../lib/party.js';
import {
  makeAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../../__test_helpers__/precondition.js';

function matchesOnly(states: Array<string | Record<string, any>>) {
  return (state: string | Record<string, any>) => {
    const key = JSON.stringify(state);
    return states.some((s) => JSON.stringify(s) === key);
  };
}

describe('SkipSongCommand', () => {
  let command: SkipSongCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new SkipSongCommand({} as any, {} as any);
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
      (partyService.getSnapshot as any).mockReturnValue({ matches: matchesOnly(['idle']) });
      const interaction = makeAdminInteraction();
      await command.chatInputRun(interaction as any);
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
      await command.chatInputRun(interaction as any);
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: "the listening party isn't skippable yet!",
        flags: MessageFlags.Ephemeral,
      });
    });

    it('sends SKIP_SONG and replies when streaming is active', async () => {
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const interaction = makeAdminInteraction();
      await command.chatInputRun(interaction as any);
      expect(partyService.send).toHaveBeenCalledWith({ type: 'SKIP_SONG' });
      expect(interaction.reply).toHaveBeenCalledWith({ content: 'Skipping current song...' });
    });
  });
});
