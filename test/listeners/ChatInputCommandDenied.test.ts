import { describe, it, expect, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { UserError } from '@sapphire/framework';
import { ChatInputCommandDenied } from '@src/listeners/ChatInputCommandDenied.js';

function makeInteraction(overrides: { deferred?: boolean; replied?: boolean } = {}): any {
  return {
    deferred: overrides.deferred ?? false,
    replied: overrides.replied ?? false,
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// Minimal Piece.LoaderContext stub — the constructor only reads these fields,
// and run() doesn't touch `this`, so nothing else needs wiring.
const loaderContext = {
  store: { name: 'listeners' },
  path: '',
  root: '',
  name: 'ChatInputCommandDenied',
} as any;

function run(error: UserError, interaction: any) {
  const listener = new ChatInputCommandDenied(loaderContext);
  return listener.run(error, { interaction } as any);
}

describe('ChatInputCommandDenied', () => {
  it('replies ephemerally with the error message when interaction is fresh', async () => {
    const interaction = makeInteraction();
    const error = new UserError({ identifier: 'Denied', message: 'nope' });

    await run(error, interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'nope',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('edits the existing reply when the interaction was deferred', async () => {
    const interaction = makeInteraction({ deferred: true });
    const error = new UserError({ identifier: 'Denied', message: 'nope' });

    await run(error, interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'nope' });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('edits the existing reply when the interaction was already replied to', async () => {
    const interaction = makeInteraction({ replied: true });
    const error = new UserError({ identifier: 'Denied', message: 'nope' });

    await run(error, interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'nope' });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('substitutes a zero-width space when context.silent is true (reply path)', async () => {
    const interaction = makeInteraction();
    const error = new UserError({
      identifier: 'Denied',
      message: 'nope',
      context: { silent: true },
    });

    await run(error, interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '\u200b',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('substitutes a zero-width space when context.silent is true (editReply path)', async () => {
    const interaction = makeInteraction({ deferred: true });
    const error = new UserError({
      identifier: 'Denied',
      message: 'nope',
      context: { silent: true },
    });

    await run(error, interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: '\u200b' });
  });
});
