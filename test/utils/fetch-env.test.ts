import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchEnv, fetchEnvironment } from '../../src/utils/fetch-env.js';

const TEST_VAR = 'CHORUS_TEST_FETCH_ENV_VAR';

describe('fetchEnv', () => {
  let originalValue: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalValue = process.env[TEST_VAR];
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env[TEST_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[TEST_VAR];
    else process.env[TEST_VAR] = originalValue;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns the value when set and truthy', () => {
    process.env[TEST_VAR] = 'hello';
    expect(fetchEnv(TEST_VAR)).toBe('hello');
  });

  it('throws when the variable is unset', () => {
    expect(() => fetchEnv(TEST_VAR)).toThrow(`environment variable '${TEST_VAR}' not found`);
  });

  it('throws when the variable is set but empty', () => {
    process.env[TEST_VAR] = '';
    expect(() => fetchEnv(TEST_VAR)).toThrow(`environment variable '${TEST_VAR}' not found`);
  });
});

describe('fetchEnvironment', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns NODE_ENV when set to a non-empty value', () => {
    process.env.NODE_ENV = 'production';
    expect(fetchEnvironment()).toBe('production');
  });

  it("returns 'development' when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    expect(fetchEnvironment()).toBe('development');
  });

  it("returns 'development' when NODE_ENV is blank", () => {
    process.env.NODE_ENV = '';
    expect(fetchEnvironment()).toBe('development');
  });

  it("returns 'development' when NODE_ENV is whitespace-only", () => {
    process.env.NODE_ENV = '   ';
    expect(fetchEnvironment()).toBe('development');
  });

  it('trims the NODE_ENV value when present', () => {
    process.env.NODE_ENV = '  staging  ';
    expect(fetchEnvironment()).toBe('staging');
  });
});
