import { describe, it, expect } from 'vitest';
import { isCompoAdmin } from './CompoAdminOnly.js';
import { roleIds } from '../utils/roles.js';
import {
  makeAdminInteraction,
  makeThasauceAdminInteraction,
  makeNonAdminInteraction,
  makeMissingMemberInteraction,
} from '../__test_helpers__/interaction.js';
import { runCompoAdminOnly } from '../__test_helpers__/precondition.js';

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

describe('CompoAdminOnly.chatInputRun', () => {
  it('returns ok() for a member with compoAdmin role', async () => {
    const result = await runCompoAdminOnly(makeAdminInteraction());
    expect(result.isOk()).toBe(true);
  });

  it('returns ok() for a member with thasauceAdmin role', async () => {
    const result = await runCompoAdminOnly(makeThasauceAdminInteraction());
    expect(result.isOk()).toBe(true);
  });

  it('returns error() for a member without admin roles', async () => {
    const result = await runCompoAdminOnly(makeNonAdminInteraction());
    expect(result.isErr()).toBe(true);
    expect((result as any).unwrapErr().message).toBe(
      "you're not allowed to run compoverse commands",
    );
  });

  it('returns error() when the guild member lookup yields undefined', async () => {
    const result = await runCompoAdminOnly(makeMissingMemberInteraction());
    expect(result.isErr()).toBe(true);
  });

  it('fetches the member from the guild when not in cache', async () => {
    const interaction = makeAdminInteraction();
    // Empty the cache so the fallback `fetch` path is exercised; the interaction
    // helper also populates `fetch` to return the same member.
    interaction.guild.members.cache = { get: () => undefined };
    const result = await runCompoAdminOnly(interaction);
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith(interaction.user.id);
    expect(result.isOk()).toBe(true);
  });
});
