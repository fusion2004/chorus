import type { StateValue } from 'xstate';

// Flatten an XState v5 snapshot.value into one dot-separated tag per active
// leaf state. Parallel states yield one tag per branch. The format is
// `<machine>.state.<path...>.<leaf>` so logs can be filtered by machine,
// region, or leaf in Railway.
export function xstateTags(machine: string, value: StateValue): string[] {
  const prefix = `${machine}.state`;
  return walk(value, []).map((path) => [prefix, ...path].join('.'));
}

function walk(value: StateValue, path: string[]): string[][] {
  if (typeof value === 'string') {
    return [[...path, value]];
  }
  return Object.entries(value).flatMap(([key, sub]) => walk(sub, [...path, key]));
}
