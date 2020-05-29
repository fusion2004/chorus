const { createMachine, interpret } = require('xstate');
const { createUpdater } = require('@xstate/immer');

const streamUpdater = createUpdater('UPDATE_STREAM', (context, { input: { manager, channel } }) => {
  context.stream.manager = manager;
  context.stream.channel = channel;
});

let machine = createMachine({
  id: 'store',
  context: {
    stream: {
      manager: undefined,
      channel: undefined
    }
  },
  type: 'parallel',
  states: {
    stream: {
      initial: 'init',
      states: {
        init: {
          on: {
            [streamUpdater.type]: {
              actions: streamUpdater.action
            }
          }
        }
      }
    }
  }
});

let store = interpret(machine);
store.start();

module.exports = { store, streamUpdater };
