const { createMachine, interpret, send } = require('xstate');
const { createUpdater, assign } = require('@xstate/immer');
const fs = require('fs');
const path = require('path');

const CompoThaSauceFetcher = require('./compo_thasauce_fetcher');
const Song = require('./song');
const RoundFetcher = require('./round_fetcher');
const RoundTranscoder = require('./round_transcoder');

const streamUpdater = createUpdater('UPDATE_STREAM', (context, { input: { manager, channel } }) => {
  context.stream.manager = manager;
  context.stream.channel = channel;
});

function songExistsInArray(song, array) {
  return array.some((item) => song.id === item.id);
}

function splitAtIndex(str, index) {
  return [str.substring(0, index), str.substring(index)];
}

function roundTitle(prefix, id) {
  switch (prefix) {
    case 'OHC':
      return `One Hour Compo Round ${id}`;
    case '2HTS':
      return `Two Hour Track Sundays Round ${id}`;
    case '90MC':
      return `Ninety Minute Compo Round ${id}`;
    default:
      return `${prefix}${id}`;
  }
}

function makeRoundDirectories(dirs) {
  let directories = [dirs.parent, dirs.download, dirs.transcode, dirs.announcer];
  directories.forEach((dir) => {
    makeDirectoryIfItDoesntExist(dir);
  });
}

function makeDirectoryIfItDoesntExist(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

function roundPrefixAndId(fullId) {
  let prefix, id;

  // Try to match 3-character compos first
  [prefix, id] = splitAtIndex(fullId, 3);
  if (['OHC'].includes(prefix)) {
    return { prefix, id };
  }

  // If no match, try to match 4-character compos
  [prefix, id] = splitAtIndex(fullId, 4);
  if (['2HTS', '90MC'].includes(prefix)) {
    return { prefix, id };
  }

  return { prefix: null, id };
}

function startFetchMessage(channel, round) {
  channel.send(`*Gathering round ${round} metadata...*`);
}

function fetchErrorMessage(channel) {
  return channel.send(`There was an error fetching the round.`);
}

let fetchingMessageMachine = createMachine({
  id: 'fetchingMessage',
  initial: 'sendInitialMessage',
  states: {
    sendInitialMessage: {
      entry: assign((context) => {
        context.total = context.songs.length;
      }),
      invoke: {
        src: (context) => context.channel.send(`*Downloading ${context.round} songs...*`),
        onDone: {
          target: 'waiting',
          actions: assign((context, event) => {
            context.message = event.data;
          }),
        },
        onError: {
          target: 'done',
        },
      },
    },
    waiting: {
      after: {
        1500: { target: 'choose' },
      },
    },
    choose: {
      entry: assign((context) => {
        let downloading = context.songs.filter(
          (song) =>
            song.service.state.matches('fetched') || song.service.state.matches('downloading')
        );
        context.completed = context.total - downloading.length;
      }),
      always: [
        { target: 'finalizeMessage', cond: (context) => context.completed === context.total },
        { target: 'updateMessage' },
      ],
    },
    updateMessage: {
      invoke: {
        src: (context) => {
          return context.message.edit(
            `*Downloading ${context.round} songs... ${context.completed}/${context.total}*`
          );
        },
        onDone: {
          target: 'waiting',
        },
        onError: {
          target: 'waiting',
        },
      },
    },
    finalizeMessage: {
      invoke: {
        src: (context) => {
          return context.message.edit(`*Downloading ${context.round} songs... done!*`);
        },
        onDone: {
          target: 'done',
        },
      },
    },
    done: {
      type: 'final',
    },
  },
});

let transcodingMessageMachine = createMachine({
  id: 'transcodingMessage',
  initial: 'sendInitialMessage',
  states: {
    sendInitialMessage: {
      entry: assign((context) => {
        context.total = context.songs.length;
      }),
      invoke: {
        src: (context) =>
          context.channel.send(`*Transcoding ${context.round} songs for streaming...*`),
        onDone: {
          target: 'waiting',
          actions: assign((context, event) => {
            context.message = event.data;
          }),
        },
        onError: {
          target: 'done',
        },
      },
    },
    waiting: {
      after: {
        1500: { target: 'choose' },
      },
    },
    choose: {
      entry: assign((context) => {
        let transcoding = context.songs.filter(
          (song) =>
            song.service.state.matches('downloaded') || song.service.state.matches('transcoding')
        );
        context.completed = context.total - transcoding.length;
      }),
      always: [
        { target: 'finalizeMessage', cond: (context) => context.completed === context.total },
        { target: 'updateMessage' },
      ],
    },
    updateMessage: {
      invoke: {
        src: (context) => {
          return context.message.edit(
            `*Transcoding ${context.round} songs for streaming... ${context.completed}/${context.total}*`
          );
        },
        onDone: {
          target: 'waiting',
        },
        onError: {
          target: 'waiting',
        },
      },
    },
    finalizeMessage: {
      invoke: {
        src: (context) => {
          return context.message.edit(
            `*Transcoding ${context.round} songs for streaming... done!*`
          );
        },
        onDone: {
          target: 'done',
        },
      },
    },
    done: {
      type: 'final',
    },
  },
});

let machine = createMachine(
  {
    id: 'party',
    initial: 'idle',
    context: {
      channel: undefined,
      round: undefined,
      fetcher: undefined,
      downloader: undefined,
      transcoder: undefined,
      songs: undefined,
    },
    states: {
      idle: {
        on: {
          START: {
            target: 'partying',
            actions: ['setRoundContext', 'makeRoundDirectories'],
          },
        },
      },
      partying: {
        entry: assign((context) => {
          context.fetcher = new CompoThaSauceFetcher(context.round.fullId);
          context.downloader = new RoundFetcher();
          context.transcoder = new RoundTranscoder();
        }),
        type: 'parallel',
        on: {
          STOP: {
            target: 'idle',
            actions: assign((context) => {
              context.channel = undefined;
              context.round = undefined;
              context.fetcher = undefined;
              context.downloader = undefined;
              context.songs = undefined;
            }),
          },
        },
        states: {
          processing: {
            initial: 'fetching',
            states: {
              fetching: {
                entry: (context) => startFetchMessage(context.channel, context.round.fullId),
                invoke: {
                  id: 'fetchRoundMetadata',
                  src: (context) => context.fetcher.fetch(),
                  onDone: {
                    target: 'transitionProcessedSongs',
                    actions: [
                      assign((context, event) => {
                        context.fetchedSongs = event.data.songs;
                      }),
                      'reconcileFetchedSongs',
                    ],
                  },
                  onError: {
                    target: 'fetchError',
                  },
                },
              },
              fetchError: {
                invoke: {
                  src: (context) => fetchErrorMessage(context.channel),
                  onDone: {
                    actions: send('STOP'),
                  },
                  onError: {
                    actions: send('STOP'),
                  },
                },
              },
              transitionProcessedSongs: {
                invoke: {
                  id: 'processedSongTransitioner',
                  src: (context) =>
                    Promise.all(context.songs.map((song) => song.transitionIfProcessed())),
                  onDone: {
                    target: 'downloading',
                  },
                },
              },
              downloading: {
                invoke: [
                  // This is the service that actually downloads the songs, but we don't use it to exit
                  // this state.
                  {
                    id: 'roundDownloader',
                    src: (context) => context.downloader.fetch(context.songs),
                    onError: {
                      actions: ['downloadErrorMessage', send('STOP')],
                    },
                  },
                  // Instead we exit the state when the discord message finishes updating, so that it can
                  // reach a done state that makes sense to users.
                  {
                    id: 'fetchingMessage',
                    src: fetchingMessageMachine,
                    data: {
                      channel: (context) => context.channel,
                      round: (context) => context.round.fullId,
                      songs: (context) => context.songs,
                    },
                    onDone: {
                      target: 'transcoding',
                    },
                  },
                ],
              },
              transcoding: {
                invoke: [
                  // This is the service that actually transcodes the songs, but we don't use it to exit
                  // this state.
                  {
                    id: 'roundTranscoder',
                    src: (context) => context.transcoder.transcode(context.songs),
                  },
                  // Instead we exit the state when the discord message finishes updating, so that it can
                  // reach a done state that makes sense to users.
                  {
                    id: 'transcodingMessage',
                    src: transcodingMessageMachine,
                    data: {
                      channel: (context) => context.channel,
                      round: (context) => context.round.fullId,
                      songs: (context) => context.songs,
                    },
                    onDone: {
                      target: 'generatingAnnouncer',
                    },
                  },
                ],
              },
              generatingAnnouncer: {},
              idle: {
                on: {
                  FETCH: { target: 'fetching' },
                },
              },
            },
          },
          streaming: {
            initial: 'idle',
            states: {
              idle: {
                on: {
                  FETCHED: { target: 'playing' },
                },
              },
              playing: {},
            },
          },
        },
      },
    },
  },
  {
    actions: {
      makeRoundDirectories: (context) => makeRoundDirectories(context.round.dirs),
      setRoundContext: assign((context, { channel, round }) => {
        let { id, prefix } = roundPrefixAndId(round);
        let parent = path.join(path.dirname(__dirname), 'tmp', 'rounds', round);
        context.channel = channel;
        context.round = {
          fullId: round,
          id,
          prefix,
          title: roundTitle(prefix, id),
          dirs: {
            parent,
            download: path.join(parent, 'download'),
            transcode: path.join(parent, 'transcode'),
            announcer: path.join(parent, 'announcer'),
          },
        };
      }),
      reconcileFetchedSongs: assign((context) => {
        let currentSongs = context.songs || [];

        context.songs = context.fetchedSongs.map((songData) => {
          let mappedSong = currentSongs.find((song) => song.id === songData.id);
          if (!mappedSong) {
            mappedSong = new Song(context.round.dirs.parent);
            mappedSong.service.send('FETCH_FINISH', songData);
          }
          return mappedSong;
        });
      }),
    },
  }
);

let partyService = interpret(machine).onTransition((state) => {
  console.log('Party service transition:');
  console.log('  State:', state.value);
  console.log('  Event:', JSON.stringify(state.event, null, 2));
});
partyService.start();

module.exports = { partyService, streamUpdater };
