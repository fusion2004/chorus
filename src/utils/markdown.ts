const unsafeCharactersRegex = /([*_\\|`~])/g;

function escapeDiscordMarkdown(input) {
  return input.replace(unsafeCharactersRegex, '\\$1');
}

module.exports = { escapeDiscordMarkdown };
