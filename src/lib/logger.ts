import chalk from 'chalk';
import { createMachine, createActor, assign, fromPromise } from 'xstate';
import type { TextChannel } from 'discord.js';

function sendMessages(channel: TextChannel, messages: string[]): Promise<any> {
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
              console.error('Error sending debug channel messages');
              console.log(event);
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

const debugChannelService = createActor(debugChannelMachine);
debugChannelService.start();

const typeFormatter = new Map<string, (text: string) => string>();
typeFormatter.set('error', chalk.red);
typeFormatter.set('success', chalk.green);
typeFormatter.set('info', chalk.blue);
typeFormatter.set('warn', chalk.yellow);

function formatTextForConsole(text: string, type?: string): string {
  if (type && typeFormatter.has(type)) {
    return typeFormatter.get(type)!(text);
  }
  return text;
}

export function setDebugChannel(channel: TextChannel): void {
  debugChannelService.send({ type: 'SET_DEBUG_CHANNEL', channel });
}

export function log(text: string, type?: string): void {
  console.log(formatTextForConsole(text, type));
  debugChannelService.send({ type: 'SEND_MESSAGE', message: text });
}
