import { vi } from 'vitest';
import { roleIds } from '@src/utils/roles.js';

interface MockInteractionOverrides {
  roles?: string[];
  options?: Record<string, unknown>;
  memberMissing?: boolean;
  userId?: string;
  channelName?: string;
  guildName?: string;
  username?: string;
}

export function makeMockInteraction(overrides: MockInteractionOverrides = {}): any {
  const roles = overrides.roles ?? [];
  const userId = overrides.userId ?? 'user-1';
  const username = overrides.username ?? 'testuser';

  const member = overrides.memberMissing
    ? undefined
    : {
        user: { id: userId, username, toString: () => `<@${userId}>` },
        roles: {
          cache: {
            has: (id: string) => roles.includes(id),
          },
        },
      };

  const cache = new Map<string, unknown>();
  if (member) cache.set(userId, member);

  const channel = {
    name: overrides.channelName ?? 'general',
    toString: () => '<#channel-1>',
  };

  const guild = {
    name: overrides.guildName ?? 'TestGuild',
    members: {
      cache: {
        get: (id: string) => cache.get(id),
      },
      fetch: vi.fn(async (id: string) => cache.get(id)),
    },
  };

  const opts = overrides.options ?? {};
  const options = {
    getString: vi.fn((name: string, _required?: boolean) => (opts[name] as string) ?? ''),
    getInteger: vi.fn((name: string) => (opts[name] as number) ?? null),
  };

  return {
    options,
    member,
    user: { id: userId, username, toString: () => `<@${userId}>` },
    guild,
    channel,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeAdminInteraction(overrides: MockInteractionOverrides = {}): any {
  return makeMockInteraction({
    ...overrides,
    roles: [roleIds.compoAdmin, ...(overrides.roles ?? [])],
  });
}

export function makeThasauceAdminInteraction(overrides: MockInteractionOverrides = {}): any {
  return makeMockInteraction({
    ...overrides,
    roles: [roleIds.thasauceAdmin, ...(overrides.roles ?? [])],
  });
}

export function makeNonAdminInteraction(overrides: MockInteractionOverrides = {}): any {
  return makeMockInteraction({
    ...overrides,
    roles: ['unrelated-role', ...(overrides.roles ?? [])],
  });
}

export function makeMissingMemberInteraction(overrides: MockInteractionOverrides = {}): any {
  return makeMockInteraction({ ...overrides, memberMissing: true });
}
