import { describe, it, expect } from 'vitest';
import { memberHasOneOfTheseRoles, roleIds } from '@src/utils/roles.js';

function makeMember(memberRoleIds: string[]) {
  return {
    roles: {
      cache: {
        has: (id: string) => memberRoleIds.includes(id),
      },
    },
  };
}

describe('memberHasOneOfTheseRoles', () => {
  it('returns true when member has the single matching role', () => {
    const member = makeMember(['role-a']);
    expect(memberHasOneOfTheseRoles(member, ['role-a'])).toBe(true);
  });

  it('returns true when member has at least one of several queried roles', () => {
    const member = makeMember(['role-b', 'role-c']);
    expect(memberHasOneOfTheseRoles(member, ['role-a', 'role-b'])).toBe(true);
  });

  it('returns false when member has none of the queried roles', () => {
    const member = makeMember(['role-x']);
    expect(memberHasOneOfTheseRoles(member, ['role-a', 'role-b'])).toBe(false);
  });

  it('returns false for an empty roleIds query array', () => {
    const member = makeMember(['role-a']);
    expect(memberHasOneOfTheseRoles(member, [])).toBe(false);
  });

  it('returns false for a member with no roles', () => {
    const member = makeMember([]);
    expect(memberHasOneOfTheseRoles(member, ['role-a'])).toBe(false);
  });

  it('exposes the known role ids for thasauceAdmin and compoAdmin', () => {
    expect(roleIds.thasauceAdmin).toBeTruthy();
    expect(roleIds.compoAdmin).toBeTruthy();
    expect(roleIds.thasauceAdmin).not.toBe(roleIds.compoAdmin);
  });
});
