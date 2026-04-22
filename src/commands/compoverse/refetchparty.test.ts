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
import { RefetchPartyCommand } from './refetchparty.js';
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

describe('RefetchPartyCommand', () => {
  let command: RefetchPartyCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new RefetchPartyCommand({} as any, {} as any);
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

    it('replies ephemerally when processing is not idle (fetch already running)', async () => {
      // matches('idle') → false; matches({ partying: { processing: 'idle' } }) → false
      (partyService.getSnapshot as any).mockReturnValue({ matches: () => false });
      const interaction = makeAdminInteraction();
      await command.chatInputRun(interaction as any);
      expect(partyService.send).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: 'there is already a fetch or refetch running!',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('sends REFETCH and replies when processing is idle and party is running', async () => {
      (partyService.getSnapshot as any).mockReturnValue({
        matches: matchesOnly([{ partying: { processing: 'idle' } }]),
      });
      const interaction = makeAdminInteraction();
      await command.chatInputRun(interaction as any);
      expect(partyService.send).toHaveBeenCalledWith({
        type: 'REFETCH',
        channel: interaction.channel,
      });
      expect(interaction.reply).toHaveBeenCalledWith({ content: 'Refetching round...' });
    });
  });
});
