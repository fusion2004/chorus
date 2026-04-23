import { describe, it, expect, beforeAll } from 'vitest';
import { container } from '@sapphire/pieces';
import { isCompoAdmin, CompoAdminOnly } from './CompoAdminOnly.js';
import { roleIds } from '../utils/roles.js';
import {
  makeAdminInteraction,
  makeThasauceAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../__test_helpers__/interaction.js';
import { registerForTest } from '../__test_helpers__/sapphire.js';

function makeMember(ids: string[]) {
  return {
    roles: {
      cache: {
        has: (id: string) => ids.includes(id),
      },
    },
  } as any;
}

describe('isCompoAdmin', () => {
  it('returns true for a compoAdmin role', () => {
    expect(isCompoAdmin(makeMember([roleIds.compoAdmin]))).toBe(true);
  });

  it('returns true for a thasauceAdmin role', () => {
    expect(isCompoAdmin(makeMember([roleIds.thasauceAdmin]))).toBe(true);
  });

  it('returns false for unrelated roles only', () => {
    expect(isCompoAdmin(makeMember(['some-other-role']))).toBe(false);
  });

  it('returns false for a member with no roles', () => {
    expect(isCompoAdmin(makeMember([]))).toBe(false);
  });

  it('returns false for null member', () => {
    expect(isCompoAdmin(null)).toBe(false);
  });

  it('returns false for undefined member (guards against the prior crash)', () => {
    expect(isCompoAdmin(undefined)).toBe(false);
  });
});

describe('CompoAdminOnly precondition (via Sapphire store)', () => {
  beforeAll(async () => {
    // Bootstrap the Sapphire stores and register CompoAdminOnly; command is a
    // required part of registerForTest's API, but none of the assertions here
    // depend on it — any registered command works.
    const { VoteJarskiCommand } = await import('../commands/compoverse/votejarski.js');
    await registerForTest({
      preconditions: [{ name: 'CompoAdminOnly', piece: CompoAdminOnly }],
      command: { name: 'compo-admin-only-test', piece: VoteJarskiCommand },
    });
  });

  function preconditionInstance(): any {
    return container.stores.get('preconditions').get('CompoAdminOnly');
  }

  it('the real precondition instance lives in the preconditions store', () => {
    const p = preconditionInstance();
    expect(p).toBeDefined();
    expect(p.name).toBe('CompoAdminOnly');
  });

  it('returns ok() for a member with compoAdmin role', async () => {
    const result = await preconditionInstance().chatInputRun(makeAdminInteraction(), {}, {});
    expect(result.isOk()).toBe(true);
  });

  it('returns ok() for a member with thasauceAdmin role', async () => {
    const result = await preconditionInstance().chatInputRun(
      makeThasauceAdminInteraction(),
      {},
      {},
    );
    expect(result.isOk()).toBe(true);
  });

  it('returns error() for a member without admin roles', async () => {
    const result = await preconditionInstance().chatInputRun(makeNonAdminInteraction(), {}, {});
    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().message).toBe("you're not allowed to run compoverse commands");
  });

  it('returns error() when the guild member lookup yields undefined', async () => {
    const result = await preconditionInstance().chatInputRun(
      makeMissingMemberInteraction(),
      {},
      {},
    );
    expect(result.isErr()).toBe(true);
  });

  it('falls back to guild.members.fetch() when the member is not in cache', async () => {
    const interaction = makeAdminInteraction();
    interaction.guild.members.cache = { get: () => undefined };
    const result = await preconditionInstance().chatInputRun(interaction, {}, {});
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith(interaction.user.id);
    expect(result.isOk()).toBe(true);
  });
});
