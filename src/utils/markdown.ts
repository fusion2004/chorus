const unsafeCharactersRegex = /([*_\\|`~])/g;

export function escapeDiscordMarkdown(input: string): string {
  return input.replace(unsafeCharactersRegex, '\\$1');
}
