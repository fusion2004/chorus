import { describe, it, expect } from 'vitest';
import { escapeDiscordMarkdown } from './markdown.js';

describe('escapeDiscordMarkdown', () => {
  it('escapes asterisks', () => {
    expect(escapeDiscordMarkdown('*bold*')).toBe('\\*bold\\*');
  });

  it('escapes underscores', () => {
    expect(escapeDiscordMarkdown('_italic_')).toBe('\\_italic\\_');
  });

  it('escapes backslashes', () => {
    expect(escapeDiscordMarkdown('a\\b')).toBe('a\\\\b');
  });

  it('escapes pipes', () => {
    expect(escapeDiscordMarkdown('|spoiler|')).toBe('\\|spoiler\\|');
  });

  it('escapes backticks', () => {
    expect(escapeDiscordMarkdown('`code`')).toBe('\\`code\\`');
  });

  it('escapes tildes', () => {
    expect(escapeDiscordMarkdown('~strike~')).toBe('\\~strike\\~');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeDiscordMarkdown('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeDiscordMarkdown('')).toBe('');
  });

  it('handles repeated and mixed unsafe characters', () => {
    expect(escapeDiscordMarkdown('**__~~')).toBe('\\*\\*\\_\\_\\~\\~');
    expect(escapeDiscordMarkdown('hey *there* `dude`')).toBe('hey \\*there\\* \\`dude\\`');
  });

  it('leaves other punctuation alone', () => {
    expect(escapeDiscordMarkdown('hi! (world) [test] {x} "quote"')).toBe(
      'hi! (world) [test] {x} "quote"',
    );
  });
});
