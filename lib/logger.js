const { createMachine, assign, interpret } = require('xstate');

function sendMessages(channel, messages) {
  let message = '```shell\n';
  message += messages.join('\n');
  message += '```';
  return channel.send(message);
}

let debugChannelMachine = createMachine({
  initial: 'init',
  context: {
    debugChannel: null,
    messages: [],
    nextMessages: []
  },
  states: {
    init: {
      on: {
        SET_DEBUG_CHANNEL: {
          target: 'ready',
          actions: ['setDebugChannel']
        }
      }
    },
    ready: {
      on: {
        always: [
          {
            target: 'debouncing',
            cond: 'areThereMessagesToSend'
          }
        ],
        SEND_MESSAGE: {
          target: 'debouncing',
          actions: ['addMessageToSend']
        }
      }
    },
    debouncing: {
      after: {
        2000: {
          target: 'sending'
        }
      },
      on: {
        SEND_MESSAGE: {
          actions: ['addMessageToSend']
        }
      }
    },
    sending: {
      entry: ['getMessagesReadyToSend'],
      invoke: {
        id: 'sendMessages',
        src: (context) => sendMessages(context.debugChannel, context.messages),
        onDone: {
          target: 'ready',
          actions: assign({
            messages: () => []
          })
        },
        onError: {
          target: 'ready',
          actions: (context, event) => {
            console.error('Error sending debug channel messages');
            console.log(event);
          }
        }
      },
      on: {
        SEND_MESSAGE: {
          actions: ['addMessageToSend']
        }
      }
    }
  }
}, {
  guards: {
    areThereMessagesToSend: (context) => {
      // There are messages to send if either of the message arrays have
      // any members.
      return !!(context.messages.length || context.nextMessages.length);
    }
  },
  actions: {
    setDebugChannel: assign({
      debugChannel: (context, event) => event.channel
    }),
    addMessageToSend: assign({
      nextMessages: (context, event) => [...context.nextMessages, event.message]
    }),
    getMessagesReadyToSend: assign((context) => {
      let messages = [...context.messages];
      let nextMessages = [...context.nextMessages];
      let length = messages.reduce((sum, msg) => sum + msg.length, 0);
      let msg;

      // Move messages to be sent until we hit a lot characters, so we don't
      // go over the maximum form body length in discord's API.
      while ((msg = nextMessages.shift())) {
        if (length + msg.length < 1500) {
          messages.push(msg);
          length += msg.length;
        } else {
          nextMessages.unshift(msg);
          break;
        }
      }

      return {
        ...context,
        messages,
        nextMessages
      };
    })
  }
});

let debugChannelService = interpret(debugChannelMachine);
debugChannelService.start();

function setDebugChannel(channel) {
  debugChannelService.send('SET_DEBUG_CHANNEL', { channel });
}

function log(text, type) {
  let consoleText = text;
  if (type) {
    consoleText = text[type];
  }
  console.log(consoleText);
  debugChannelService.send('SEND_MESSAGE', { message: text });
}

module.exports = { log, setDebugChannel };
