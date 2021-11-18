const { createMachine, interpret, send } = require('xstate');
const { assign } = require('@xstate/immer');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const mm = require('music-metadata');
const nodeshout = require('nodeshout-napi');
const { MessageEmbed } = require('discord.js');

const CompoThaSauceFetcher = require('./compo-thasauce-fetcher');
const { metadataUpdater } = require('./machines');
const Song = require('./song');
const RoundFetcher = require('./round-fetcher');
const RoundTranscoder = require('./round-transcoder');
const RoundAnnouncer = require('./round-announcer');
const { announcerFinal, transcodeFinal } = require('../utils/symbols');
const fetchEnv = require('../utils/fetch-env');

const { ShoutStream } = nodeshout;

nodeshout.init();

const STREAM = {
  host: fetchEnv('HUBOT_STREAM_HOST'),
  port: fetchEnv('HUBOT_STREAM_PORT'),
  mount: fetchEnv('HUBOT_STREAM_MOUNT'),
  password: fetchEnv('HUBOT_STREAM_SOURCE_PASSWORD'),
};

function streamUrl() {
  return `http://${STREAM.host}:${STREAM.port}/${STREAM.mount}.m3u`;
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
      return null;
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

async function parseMetadata(songs) {
  let promises = songs.map(async (song) => {
    let metadata = await mm.parseFile(song.path(transcodeFinal));
    song.service.send(metadataUpdater.update(metadata));
  });

  await Promise.all(promises);
}

async function playIntro(_shout, abortController) {
  let fileStream = fs.createReadStream('./audio/intro01.mp3', { highWaterMark: 65536 });
  let shoutStream = new ShoutStream(_shout);

  try {
    await pipeline(fileStream, shoutStream, { signal: abortController.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    throw error;
  }
}

async function playCurrentSong(_shout, currentSong, abortController) {
  let fileStream = fs.createReadStream(currentSong.path(announcerFinal), {
    highWaterMark: 65536,
  });
  let shoutStream = new ShoutStream(_shout);

  try {
    await pipeline(fileStream, shoutStream, { signal: abortController.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    throw error;
  }

  fileStream = fs.createReadStream(currentSong.path(transcodeFinal), {
    highWaterMark: 65536,
  });
  shoutStream = new ShoutStream(_shout);

  try {
    await pipeline(fileStream, shoutStream, { signal: abortController.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    throw error;
  }
}

function startFetchMessage(channel, round) {
  channel.send(`*Gathering round ${round} metadata...*`);
}

function fetchErrorMessage(channel) {
  return channel.send(`There was an error fetching the round.`);
}

async function startIntroMessage(channel) {
  await channel.send(`**Starting stream... ${streamUrl()}**`);
  await channel.send('**Playing stream intro before we get this party started...**');
}

async function playCurrentSongMessage({ channel, currentSong, songs, round }) {
  let index = songs.findIndex((song) => song.id === currentSong.id);
  let position = index + 1;

  const embed = new MessageEmbed()
    .setColor('#39aa6e')
    .setTitle(currentSong.safeTitle)
    .setURL(`http://compo.thasauce.net/rounds/view/${round}#entry-${currentSong.id}`)
    .setDescription(
      `${round} listening party, entry ${position} of ${songs.length}.
          [Tune in to the stream here!](${streamUrl()})`
    )
    .addField('Artist', currentSong.safeArtist)
    .addField('Length', currentSong.formattedDuration);

  // discord.js v12
  await channel.send(
    `Now Playing: ${currentSong.safeTitle} by ${currentSong.safeArtist} [${currentSong.formattedDuration}]`,
    { embed }
  );

  // TODO: discord.js v13
  // await channel.send({ embeds: [embed] });
  // await channel.send({
  //   content: `Now Playing: ${currentSong.safeTitle} by ${currentSong.safeArtist} [${length}]`,
  //   embeds: [embed],
  // });
}

function stopPartyMessage(channel) {
  return channel.send(`Stopping the listening party...*`);
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

let announcerMessageMachine = createMachine({
  id: 'announcerGeneratingMessage',
  initial: 'sendInitialMessage',
  states: {
    sendInitialMessage: {
      entry: assign((context) => {
        context.total = context.songs.length;
      }),
      invoke: {
        src: (context) =>
          context.channel.send(
            '<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises...*'
          ),
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
            song.service.state.matches('transcoded') ||
            song.service.state.matches('announcerProcessing')
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
            `<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises... ${context.completed}/${context.total}*`
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
            `<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises... done!*`
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
    context: {},
    states: {
      idle: {
        entry: assign((context) => {
          context.channel = undefined;
          context.round = undefined;
          context.fetcher = undefined;
          context.downloader = undefined;
          context.announcer = undefined;
          context.fetchedSongs = undefined;
          context.songs = undefined;
          context._shout = undefined;
          context.abortController = undefined;
          context.currentSong = undefined;
          context.nextSongId = undefined;
        }),
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
          context.announcer = new RoundAnnouncer(context.round.title);
        }),
        type: 'parallel',
        on: {
          STOP: {
            target: 'stopping',
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
                      target: 'parsingMetadata',
                    },
                  },
                ],
              },
              parsingMetadata: {
                invoke: {
                  id: 'metadataParser',
                  src: (context) => parseMetadata(context.songs),
                  onDone: {
                    target: 'generatingAnnouncer',
                  },
                },
              },
              generatingAnnouncer: {
                invoke: [
                  // This is the service that actually generates the announcer files, but we don't use it to
                  // exit this state.
                  {
                    id: 'announcerGenerator',
                    src: (context) => context.announcer.process(context.songs),
                  },
                  // Instead we exit the state when the discord message finishes updating, so that it can
                  // reach a done state that makes sense to users.
                  {
                    id: 'announcerGeneratingMessage',
                    src: announcerMessageMachine,
                    data: {
                      channel: (context) => context.channel,
                      round: (context) => context.round.fullId,
                      songs: (context) => context.songs,
                    },
                    onDone: {
                      target: 'idle',
                      actions: send('START_STREAM'),
                    },
                  },
                ],
              },
              idle: {
                on: {
                  REFETCH: { target: 'fetching' },
                },
              },
            },
          },
          streaming: {
            initial: 'idle',
            states: {
              idle: {
                on: {
                  START_STREAM: { target: 'setupNodeshout' },
                },
              },
              setupNodeshout: {
                invoke: {
                  src: 'initNodeshout',
                },
                on: {
                  PLAY_STREAM: {
                    target: 'playingIntro',
                    actions: assign((context, event) => {
                      context._shout = event._shout;
                    }),
                  },
                  ERROR_OPENING_STREAM: {
                    actions: send('STOP'),
                  },
                },
              },
              playingIntro: {
                entry: [
                  assign((context) => {
                    context.abortController = new AbortController();
                  }),
                  (context) => startIntroMessage(context.channel),
                ],
                invoke: {
                  id: 'playIntro',
                  src: 'playIntro',
                  onDone: {
                    target: 'pickNextSong',
                  },
                },
                on: {
                  SKIP_SONG: {
                    actions: (context) => context.abortController.abort(),
                  },
                },
              },
              pickNextSong: {
                entry: 'setCurrentAndNextSong',
                always: [
                  { target: 'playingSong', cond: (context) => context.currentSong },
                  { target: 'playingOutro' },
                ],
              },
              playingSong: {
                entry: [
                  assign((context) => {
                    context.abortController = new AbortController();
                  }),
                  (context) =>
                    playCurrentSongMessage({
                      channel: context.channel,
                      currentSong: context.currentSong,
                      songs: context.songs,
                      round: context.round.fullId,
                    }),
                ],
                invoke: {
                  id: 'playCurrentSong',
                  src: 'playCurrentSong',
                  onDone: {
                    target: 'pickNextSong',
                  },
                },
                on: {
                  SKIP_SONG: {
                    actions: (context) => context.abortController.abort(),
                  },
                },
              },
              playingOutro: {},
            },
          },
        },
      },
      stopping: {
        entry: 'cleanup',
        invoke: {
          id: 'stopPartyMessage',
          src: (context) => stopPartyMessage(context.channel),
          onDone: {
            target: 'idle',
          },
          onError: {
            target: 'idle',
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
          title: roundTitle(prefix, id) || round,
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
      cleanup: (context) => {
        if (context.abortController) {
          console.log('Aborting the current audio pipeline');
          context.abortController.abort();
        }
        if (context._shout) {
          console.log('Closing nodeshout connection');
          context._shout.close();
        }
      },
      setCurrentAndNextSong: assign((context) => {
        if (!context.currentSong && !context.nextSongId) {
          // We're just starting the party, so we need to grab the first song.
          let [first, second] = context.songs;

          context.currentSong = first;
          context.nextSongId = second ? second.id : null;
        } else if (!context.nextSongId) {
          // If there's no next song, we're at the end of the party.
          context.currentSong = null;
        } else {
          let previousSongIndex = context.songs.findIndex(
            (song) => song.id === context.currentSong.id
          );
          let songIndex = context.songs.findIndex((song) => song.id === context.nextSongId);

          if (songIndex === -1 && previousSongIndex === -1) {
            let [first, second] = context.songs;
            context.currentSong = first;
            context.nextSongId = second ? second.id : null;
          } else if (songIndex === -1) {
            let song = context.songs[previousSongIndex + 1];
            let next = context.songs[previousSongIndex + 1];
            context.currentSong = song;
            context.nextSongId = next ? next.id : null;
          } else {
            let next = context.songs[songIndex + 1];
            context.currentSong = context.songs[songIndex];
            context.nextSongId = next ? next.id : null;
          }
        }
      }),
    },
    services: {
      initNodeshout: (context) => (callback) => {
        let _shout = nodeshout.create();
        _shout.setHost(STREAM.host);
        _shout.setPort(STREAM.port);
        _shout.setUser('source');
        _shout.setPassword(STREAM.password);
        _shout.setMount(STREAM.mount);
        _shout.setFormat(1); // 0=ogg, 1=mp3
        _shout.setName(`${context.round.fullId} Listening Party`);
        _shout.setAudioInfo('bitrate', '320');
        _shout.setAudioInfo('samplerate', '44100');
        _shout.setAudioInfo('channels', '2');

        let errorCode = _shout.open();

        if (errorCode === nodeshout.ErrorTypes.SUCCESS) {
          callback({ type: 'PLAY_STREAM', _shout });
        } else {
          callback({ type: 'ERROR_OPENING_STREAM', errorCode });
        }

        // Perform cleanup
        return () => {};
      },
      playIntro: (context) => playIntro(context._shout, context.abortController),
      playCurrentSong: (context) =>
        playCurrentSong(context._shout, context.currentSong, context.abortController),
    },
  }
);

let partyService = interpret(machine).onTransition((state) => {
  console.log('Party service transition:');
  console.log('  State:', state.value);
  console.log('  Event:', JSON.stringify(state.event, null, 2));
});
partyService.start();

module.exports = { partyService };
