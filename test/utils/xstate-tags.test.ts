import { describe, it, expect } from 'vitest';
import { xstateTags } from '@src/utils/xstate-tags.js';

describe('xstateTags', () => {
  it('returns a single tag for a top-level string state', () => {
    expect(xstateTags('party', 'idle')).toEqual(['party.state.idle']);
  });

  it('flattens a single-key compound state into a dotted path', () => {
    expect(xstateTags('party', { partying: 'init' })).toEqual(['party.state.partying.init']);
  });

  it('returns one tag per branch of a parallel state', () => {
    expect(xstateTags('party', { processing: 'fetching', streaming: 'playing' })).toEqual([
      'party.state.processing.fetching',
      'party.state.streaming.playing',
    ]);
  });

  it('handles compound states with parallel substates', () => {
    expect(
      xstateTags('party', {
        partying: { processing: 'fetching', streaming: 'playingIntro' },
      }),
    ).toEqual([
      'party.state.partying.processing.fetching',
      'party.state.partying.streaming.playingIntro',
    ]);
  });

  it('walks arbitrarily deep nesting', () => {
    expect(
      xstateTags('song', {
        downloading: { stage: { inner: 'working' } },
      }),
    ).toEqual(['song.state.downloading.stage.inner.working']);
  });

  it('uses the supplied machine name as the root prefix', () => {
    expect(xstateTags('song', 'fetched')).toEqual(['song.state.fetched']);
  });
});
