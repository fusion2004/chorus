const roleIds = {
  thasauceAdmin: '415977325839122442',
  compoAdmin: '415977435897528323',
};

function memberHasOneOfTheseRoles(member, roleIds) {
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

module.exports = {
  roleIds,
  memberHasOneOfTheseRoles,
};
