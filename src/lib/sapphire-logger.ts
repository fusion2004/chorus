import util from 'node:util';
import pino from 'pino';
import { LogLevel, type ILogger } from '@sapphire/framework';

import { logger } from './logger.js';

const sapphirePino = logger.child({ name: 'sapphire' });

function pinoMethodFor(level: LogLevel): pino.Level | null {
  switch (level) {
    case LogLevel.Trace:
      return 'trace';
    case LogLevel.Debug:
      return 'debug';
    case LogLevel.Info:
      return 'info';
    case LogLevel.Warn:
      return 'warn';
    case LogLevel.Error:
      return 'error';
    case LogLevel.Fatal:
      return 'fatal';
    default:
      return null;
  }
}

function writeAtLevel(method: pino.Level, values: readonly unknown[]): void {
  if (values.length === 0) return;
  if (values[0] instanceof Error) {
    const [err, ...rest] = values;
    const msg = rest.length ? `[sapphire] ${util.format(...rest)}` : '[sapphire]';
    sapphirePino[method]({ err }, msg);
    return;
  }
  sapphirePino[method](`[sapphire] ${util.format(...values)}`);
}

export const sapphireLogger: ILogger = {
  has(level) {
    const method = pinoMethodFor(level);
    return method !== null && sapphirePino.isLevelEnabled(method);
  },
  trace(...values) {
    writeAtLevel('trace', values);
  },
  debug(...values) {
    writeAtLevel('debug', values);
  },
  info(...values) {
    writeAtLevel('info', values);
  },
  warn(...values) {
    writeAtLevel('warn', values);
  },
  error(...values) {
    writeAtLevel('error', values);
  },
  fatal(...values) {
    writeAtLevel('fatal', values);
  },
  write(level, ...values) {
    const method = pinoMethodFor(level);
    if (method !== null) writeAtLevel(method, values);
  },
};
