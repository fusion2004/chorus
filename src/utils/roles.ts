export const roleIds = {
  thasauceAdmin: '415977325839122442',
  compoAdmin: '415977435897528323',
};

export function memberHasOneOfTheseRoles(member, roleIds) {
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}
