import pino from 'pino';
import { createMachine, createActor, assign, fromPromise } from 'xstate';
import type { TextChannel } from 'discord.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function sendMessages(channel: TextChannel, messages: string[]): Promise<any> {
  const message = messages
    .flatMap((msg) => msg.split('\n'))
    .map((line) => `> ${line}`)
    .join('\n');
  return channel.send(message);
}

interface DebugChannelContext {
  debugChannel: TextChannel | null;
  messages: string[];
  nextMessages: string[];
}

type DebugChannelEvent =
  | { type: 'SET_DEBUG_CHANNEL'; channel: TextChannel }
  | { type: 'SEND_MESSAGE'; message: string };

export const debugChannelMachine = createMachine(
  {
    types: {} as { context: DebugChannelContext; events: DebugChannelEvent },
    initial: 'init',
    context: {
      debugChannel: null,
      messages: [],
      nextMessages: [],
    },
    states: {
      init: {
        on: {
          SET_DEBUG_CHANNEL: {
            target: 'ready',
            actions: assign(({ event }) => ({ debugChannel: event.channel })),
          },
        },
      },
      ready: {
        always: [{ target: 'debouncing', guard: 'areThereMessagesToSend' }],
        on: {
          SEND_MESSAGE: {
            target: 'debouncing',
            actions: assign(({ context, event }) => ({
              nextMessages: [...context.nextMessages, event.message],
            })),
          },
        },
      },
      debouncing: {
        after: {
          2000: { target: 'sending' },
        },
        on: {
          SEND_MESSAGE: {
            actions: assign(({ context, event }) => ({
              nextMessages: [...context.nextMessages, event.message],
            })),
          },
        },
      },
      sending: {
        entry: assign(({ context }) => {
          let messages = [...context.messages];
          let nextMessages = [...context.nextMessages];
          let length = messages.reduce((sum, msg) => sum + msg.length, 0);
          let msg: string | undefined;

          while ((msg = nextMessages.shift())) {
            if (length + msg.length < 1500) {
              messages.push(msg);
              length += msg.length;
            } else {
              nextMessages.unshift(msg);
              break;
            }
          }

          return { messages, nextMessages };
        }),
        invoke: {
          id: 'sendMessages',
          src: fromPromise(
            ({ input }: { input: { debugChannel: TextChannel; messages: string[] } }) =>
              sendMessages(input.debugChannel, input.messages),
          ),
          input: ({ context }: { context: DebugChannelContext }) => ({
            debugChannel: context.debugChannel!,
            messages: context.messages,
          }),
          onDone: {
            target: 'ready',
            actions: assign(() => ({ messages: [] })),
          },
          onError: {
            target: 'ready',
            actions: ({ event }: any) => {
              logger.error(event.error ?? event);
            },
          },
        },
        on: {
          SEND_MESSAGE: {
            actions: assign(({ context, event }) => ({
              nextMessages: [...context.nextMessages, event.message],
            })),
          },
        },
      },
    },
  },
  {
    guards: {
      areThereMessagesToSend: ({ context }) =>
        !!(context.messages.length || context.nextMessages.length),
    },
  },
);

export const debugChannelService = createActor(debugChannelMachine);
debugChannelService.start();

export function setDebugChannel(channel: TextChannel): void {
  debugChannelService.send({ type: 'SET_DEBUG_CHANNEL', channel });
}

type LogLevel = 'info' | 'warn' | 'error';

const NESTED_VALUE_LIMIT = 200;

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return `"${value.message}"`;
  if (typeof value === 'string') {
    return /[\s",]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > NESTED_VALUE_LIMIT ? `${json.slice(0, NESTED_VALUE_LIMIT - 3)}...` : json;
  }
  return String(value);
}

function formatMeta(obj: object): string {
  return Object.entries(obj)
    .map(([key, val]) => `${key}=${formatValue(val)}`)
    .join(', ');
}

export function debugText(obj: object, msg: string | undefined): string {
  if (obj instanceof Error) return msg ?? obj.message;
  const suffix = formatMeta(obj);
  if (!msg) return suffix;
  return suffix ? `${msg} · ${suffix}` : msg;
}

// uses the debugChannelService to queue and send the messages, and logs
function logAndSend(level: LogLevel, objOrMsg: object | string, msg?: string): void {
  let text: string;
  if (typeof objOrMsg === 'string') {
    logger[level](objOrMsg);
    text = objOrMsg;
  } else {
    logger[level](objOrMsg, msg);
    text = debugText(objOrMsg, msg);
  }
  if (text) {
    debugChannelService.send({
      type: 'SEND_MESSAGE',
      message: `${level.toUpperCase()}: ${text}`,
    });
  }
}

export function debugInfo(objOrMsg: object | string, msg?: string): void {
  logAndSend('info', objOrMsg, msg);
}

export function debugWarn(objOrMsg: object | string, msg?: string): void {
  logAndSend('warn', objOrMsg, msg);
}

export function debugError(objOrMsg: object | string, msg?: string): void {
  logAndSend('error', objOrMsg, msg);
}
