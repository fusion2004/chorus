import fs from 'fs';
import path from 'path';
import mm from 'music-metadata';
import nodeshout from 'nodeshout';
import type { ShoutT } from 'nodeshout';

import { createMachine, createActor, assign, raise, fromPromise, fromCallback } from 'xstate';
import type { TextChannel, Message } from 'discord.js';
import { EmbedBuilder } from 'discord.js';

import CompoThaSauceFetcher from './compo-thasauce-fetcher.js';
import { Song } from './song.js';
import { RoundFetcher } from './round-fetcher.js';
import { RoundTranscoder } from './round-transcoder.js';
import { RoundAnnouncer } from './round-announcer.js';
import { RoundExtraAnnouncer } from './round-extra-announcer.js';
import { announcerFinal, transcodeFinal } from '../utils/symbols.js';
import { fetchEnv } from '../utils/fetch-env.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

nodeshout.init();

const STREAM = {
  host: fetchEnv('HUBOT_STREAM_HOST'),
  port: parseInt(fetchEnv('HUBOT_STREAM_PORT'), 10),
  mount: fetchEnv('HUBOT_STREAM_MOUNT'),
  password: fetchEnv('HUBOT_STREAM_SOURCE_PASSWORD'),
};

function streamUrl(): string {
  return `http://${STREAM.host}:${STREAM.port}/${STREAM.mount}.m3u`;
}

function splitAtIndex(str: string, index: number): [string, string] {
  return [str.substring(0, index), str.substring(index)];
}

function roundTitle(prefix: string | null, id: string): string | null {
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

function makeRoundDirectories(dirs: RoundDirs): void {
  [dirs.parent, dirs.download, dirs.transcode, dirs.announcer, dirs.extraAnnouncer].forEach(
    (dir) => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    },
  );
}

function roundPrefixAndId(fullId: string): { prefix: string | null; id: string } {
  let [prefix, id] = splitAtIndex(fullId, 3);
  if (['OHC'].includes(prefix)) return { prefix, id };
  [prefix, id] = splitAtIndex(fullId, 4);
  if (['2HTS', '90MC'].includes(prefix)) return { prefix, id };
  return { prefix: null, id };
}

async function parseMetadata(songs: Song[]): Promise<void> {
  await Promise.all(
    songs.map(async (song) => {
      const metadata = await mm.parseFile(song.path(transcodeFinal));
      song.service.send({ type: 'UPDATE_METADATA', metadata });
    }),
  );
}

async function streamFile(shout: ShoutT, filePath: string, signal: AbortSignal): Promise<void> {
  const fileHandle = await fs.promises.open(filePath);
  const chunkSize = 65536;
  const buf = Buffer.alloc(chunkSize);

  try {
    while (true) {
      if (signal.aborted) return;
      const { bytesRead } = await fileHandle.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      shout.send(buf, bytesRead);
      await sleep(shout.delay());
    }
  } finally {
    await fileHandle.close();
  }
}

async function playIntro(shout: ShoutT, abortController: AbortController): Promise<void> {
  await streamFile(shout, './audio/intro01.mp3', abortController.signal);
}

async function playCurrentSong(
  shout: ShoutT,
  currentSong: Song,
  abortController: AbortController,
): Promise<void> {
  await streamFile(shout, currentSong.path(announcerFinal), abortController.signal);
  await streamFile(shout, currentSong.path(transcodeFinal), abortController.signal);
}

async function playOutro(
  shout: ShoutT,
  announcer: ExtraAnnouncer,
  abortController: AbortController,
): Promise<void> {
  await streamFile(shout, announcer.path, abortController.signal);
}

function startFetchMessage(channel: TextChannel, round: string): void {
  channel.send(`*Gathering round ${round} metadata...*`);
}

function fetchErrorMessage(channel: TextChannel): Promise<Message> {
  return channel.send(`There was an error fetching the round.`);
}

async function startIntroMessage(channel: TextChannel): Promise<void> {
  await channel.send(`**Starting stream... ${streamUrl()}**`);
  await channel.send('**Playing stream intro before we get this party started...**');
}

async function playCurrentSongMessage({
  channel,
  currentSong,
  songs,
  round,
}: {
  channel: TextChannel;
  currentSong: Song;
  songs: Song[];
  round: string;
}): Promise<void> {
  const index = songs.findIndex((song) => song.id === currentSong.id);
  const position = index + 1;

  const embed = new EmbedBuilder()
    .setColor(0x39aa6e)
    .setTitle(currentSong.safeTitle)
    .setURL(`http://compo.thasauce.net/rounds/view/${round}#entry-${currentSong.id}`)
    .setDescription(
      `${round} listening party, entry ${position} of ${songs.length}.\n[Tune in to the stream here!](${streamUrl()})`,
    )
    .addFields(
      { name: 'Artist', value: currentSong.safeArtist },
      { name: 'Length', value: currentSong.formattedDuration ?? 'unknown' },
    );

  await channel.send({
    content: `Now Playing: ${currentSong.safeTitle} by ${currentSong.safeArtist} [${currentSong.formattedDuration}]`,
    embeds: [embed],
  });
}

function stopPartyMessage(channel: TextChannel): Promise<Message> {
  return channel.send(`Stopping the listening party...`);
}

function partyConcludedMessage(channel: TextChannel): Promise<Message> {
  return channel.send('**The stream is concluded. See you next time!**');
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface RoundDirs {
  parent: string;
  download: string;
  transcode: string;
  announcer: string;
  extraAnnouncer: string;
}

interface RoundInfo {
  fullId: string;
  id: string;
  prefix: string | null;
  title: string;
  dirs: RoundDirs;
}

interface ExtraAnnouncer {
  id: string;
  path: string;
}

interface PartyContext {
  channels?: { processing: TextChannel; party: TextChannel };
  round?: RoundInfo;
  fetcher?: CompoThaSauceFetcher;
  downloader?: RoundFetcher;
  transcoder?: RoundTranscoder;
  announcer?: RoundAnnouncer;
  extraAnnouncer?: RoundExtraAnnouncer;
  fetchedSongs?: any[];
  songs?: Song[];
  _shout?: any;
  abortController?: AbortController;
  currentSong?: Song | null;
  nextSongId?: string | null;
  outroAnnouncer?: ExtraAnnouncer;
}

type PartyEvent =
  | { type: 'START'; channel: TextChannel; round: string }
  | { type: 'STOP'; immediate?: boolean }
  | { type: 'SKIP_SONG' }
  | { type: 'REFETCH'; channel: TextChannel }
  | { type: 'START_STREAM' }
  | { type: 'PLAY_STREAM'; _shout: any }
  | { type: 'ERROR_OPENING_STREAM'; errorCode: number };

// ─── Message Sub-Machines ────────────────────────────────────────────────────

interface MessageMachineInput {
  channel: TextChannel;
  round: string;
  songs: Song[];
}

interface MessageMachineContext extends MessageMachineInput {
  total: number;
  completed: number;
  message: Message | null;
}

const fetchingMessageMachine = createMachine({
  types: {} as { input: MessageMachineInput; context: MessageMachineContext },
  id: 'fetchingMessage',
  initial: 'sendInitialMessage',
  context: ({ input }) => ({
    channel: input.channel,
    round: input.round,
    songs: input.songs,
    total: input.songs.length,
    completed: 0,
    message: null,
  }),
  states: {
    sendInitialMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.channel.send(`*Downloading ${input.round} songs...*`),
        ),
        input: ({ context }) => context,
        onDone: {
          target: 'waiting',
          actions: assign(({ event }) => ({ message: event.output })),
        },
        onError: { target: 'done' },
      },
    },
    waiting: {
      after: { 1500: { target: 'choose' } },
    },
    choose: {
      entry: assign(({ context }) => {
        const downloading = context.songs.filter(
          (song) =>
            song.service.getSnapshot().matches('fetched') ||
            song.service.getSnapshot().matches('downloading'),
        );
        return { completed: context.total - downloading.length };
      }),
      always: [
        { target: 'finalizeMessage', guard: ({ context }) => context.completed === context.total },
        { target: 'updateMessage' },
      ],
    },
    updateMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(
            `*Downloading ${input.round} songs... ${input.completed}/${input.total}*`,
          ),
        ),
        input: ({ context }) => context,
        onDone: { target: 'waiting' },
        onError: { target: 'waiting' },
      },
    },
    finalizeMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(`*Downloading ${input.round} songs... done!*`),
        ),
        input: ({ context }) => context,
        onDone: { target: 'done' },
      },
    },
    done: { type: 'final' as const },
  },
});

const transcodingMessageMachine = createMachine({
  types: {} as { input: MessageMachineInput; context: MessageMachineContext },
  id: 'transcodingMessage',
  initial: 'sendInitialMessage',
  context: ({ input }) => ({
    channel: input.channel,
    round: input.round,
    songs: input.songs,
    total: input.songs.length,
    completed: 0,
    message: null,
  }),
  states: {
    sendInitialMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.channel.send(`*Transcoding ${input.round} songs for streaming...*`),
        ),
        input: ({ context }) => context,
        onDone: {
          target: 'waiting',
          actions: assign(({ event }) => ({ message: event.output })),
        },
        onError: { target: 'done' },
      },
    },
    waiting: {
      after: { 1500: { target: 'choose' } },
    },
    choose: {
      entry: assign(({ context }) => {
        const transcoding = context.songs.filter(
          (song) =>
            song.service.getSnapshot().matches('downloaded') ||
            song.service.getSnapshot().matches('transcoding'),
        );
        return { completed: context.total - transcoding.length };
      }),
      always: [
        { target: 'finalizeMessage', guard: ({ context }) => context.completed === context.total },
        { target: 'updateMessage' },
      ],
    },
    updateMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(
            `*Transcoding ${input.round} songs for streaming... ${input.completed}/${input.total}*`,
          ),
        ),
        input: ({ context }) => context,
        onDone: { target: 'waiting' },
        onError: { target: 'waiting' },
      },
    },
    finalizeMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(`*Transcoding ${input.round} songs for streaming... done!*`),
        ),
        input: ({ context }) => context,
        onDone: { target: 'done' },
      },
    },
    done: { type: 'final' as const },
  },
});

const announcerMessageMachine = createMachine({
  types: {} as { input: MessageMachineInput; context: MessageMachineContext },
  id: 'announcerGeneratingMessage',
  initial: 'sendInitialMessage',
  context: ({ input }) => ({
    channel: input.channel,
    round: input.round,
    songs: input.songs,
    total: input.songs.length,
    completed: 0,
    message: null,
  }),
  states: {
    sendInitialMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.channel.send(
            '<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises...*',
          ),
        ),
        input: ({ context }) => context,
        onDone: {
          target: 'waiting',
          actions: assign(({ event }) => ({ message: event.output })),
        },
        onError: { target: 'done' },
      },
    },
    waiting: {
      after: { 1500: { target: 'choose' } },
    },
    choose: {
      entry: assign(({ context }) => {
        const transcoding = context.songs.filter(
          (song) =>
            song.service.getSnapshot().matches('transcoded') ||
            song.service.getSnapshot().matches('announcerProcessing'),
        );
        return { completed: context.total - transcoding.length };
      }),
      always: [
        { target: 'finalizeMessage', guard: ({ context }) => context.completed === context.total },
        { target: 'updateMessage' },
      ],
    },
    updateMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(
            `<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises... ${input.completed}/${input.total}*`,
          ),
        ),
        input: ({ context }) => context,
        onDone: { target: 'waiting' },
        onError: { target: 'waiting' },
      },
    },
    finalizeMessage: {
      invoke: {
        src: fromPromise(({ input }: { input: MessageMachineContext }) =>
          input.message!.edit(
            '<:chorus_singing:802805196920061982> *Clearing throat, performing vocal exercises... done!*',
          ),
        ),
        input: ({ context }) => context,
        onDone: { target: 'done' },
      },
    },
    done: { type: 'final' as const },
  },
});

// ─── Main Party Machine ──────────────────────────────────────────────────────

function reconcileSongs(
  currentSongs: Song[] | undefined,
  fetchedSongs: any[],
  roundDir: string,
): Song[] {
  const existing = currentSongs ?? [];
  return fetchedSongs.map((songData) => {
    let song = existing.find((s) => s.id === songData.id);
    if (!song) {
      song = new Song(roundDir);
      song.service.send({ type: 'FETCH_FINISH', ...songData });
    }
    return song;
  });
}

const machine = createMachine(
  {
    types: {} as { context: PartyContext; events: PartyEvent },
    id: 'party',
    initial: 'idle',
    context: {},
    states: {
      idle: {
        entry: assign(() => ({
          channels: undefined,
          round: undefined,
          fetcher: undefined,
          downloader: undefined,
          announcer: undefined,
          fetchedSongs: undefined,
          songs: undefined,
          _shout: undefined,
          abortController: undefined,
          currentSong: undefined,
          nextSongId: undefined,
          outroAnnouncer: undefined,
        })),
        on: {
          START: {
            target: 'partying',
            actions: ['setRoundContext', 'makeRoundDirectories'],
          },
        },
      },
      partying: {
        entry: assign(({ context }) => ({
          fetcher: new CompoThaSauceFetcher(context.round!.fullId),
          downloader: new RoundFetcher(),
          transcoder: new RoundTranscoder(),
          announcer: new RoundAnnouncer(context.round!.title),
          extraAnnouncer: new RoundExtraAnnouncer(context.round!.title),
        })),
        type: 'parallel',
        on: { STOP: { target: 'stopping' } },
        states: {
          processing: {
            initial: 'fetching',
            states: {
              fetching: {
                entry: ({ context }) =>
                  startFetchMessage(context.channels!.processing, context.round!.fullId),
                invoke: {
                  id: 'fetchRoundMetadata',
                  src: fromPromise(({ input }: { input: PartyContext }) => input.fetcher!.fetch()),
                  input: ({ context }) => context,
                  onDone: {
                    target: 'transitionProcessedSongs',
                    actions: [
                      assign(({ context, event }) => ({
                        fetchedSongs: event.output.songs,
                        songs: reconcileSongs(
                          context.songs,
                          event.output.songs,
                          context.round!.dirs.parent,
                        ),
                      })),
                    ],
                  },
                  onError: { target: 'fetchError' },
                },
              },
              fetchError: {
                invoke: {
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    fetchErrorMessage(input.channels!.processing),
                  ),
                  input: ({ context }) => context,
                  onDone: { actions: raise({ type: 'STOP' }) },
                  onError: { actions: raise({ type: 'STOP' }) },
                },
              },
              transitionProcessedSongs: {
                invoke: {
                  id: 'processedSongTransitioner',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    Promise.all(input.songs!.map((song) => song.transitionIfProcessed())),
                  ),
                  input: ({ context }) => context,
                  onDone: { target: 'downloading' },
                },
              },
              downloading: {
                invoke: [
                  {
                    id: 'roundDownloader',
                    src: fromPromise(({ input }: { input: PartyContext }) =>
                      input.downloader!.fetch(input.songs!),
                    ),
                    input: ({ context }) => context,
                    onError: { actions: raise({ type: 'STOP' }) },
                  },
                  {
                    id: 'fetchingMessage',
                    src: fetchingMessageMachine,
                    input: ({ context }) => ({
                      channel: context.channels!.processing,
                      round: context.round!.fullId,
                      songs: context.songs!,
                    }),
                    onDone: { target: 'transcoding' },
                  },
                ],
              },
              transcoding: {
                invoke: [
                  {
                    id: 'roundTranscoder',
                    src: fromPromise(({ input }: { input: PartyContext }) =>
                      input.transcoder!.transcode(input.songs!),
                    ),
                    input: ({ context }) => context,
                  },
                  {
                    id: 'transcodingMessage',
                    src: transcodingMessageMachine,
                    input: ({ context }) => ({
                      channel: context.channels!.processing,
                      round: context.round!.fullId,
                      songs: context.songs!,
                    }),
                    onDone: { target: 'parsingMetadata' },
                  },
                ],
              },
              parsingMetadata: {
                invoke: {
                  id: 'metadataParser',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    parseMetadata(input.songs!),
                  ),
                  input: ({ context }) => context,
                  onDone: { target: 'generatingAnnouncer' },
                },
              },
              generatingAnnouncer: {
                invoke: [
                  {
                    id: 'announcerGenerator',
                    src: fromPromise(({ input }: { input: PartyContext }) =>
                      input.announcer!.process(input.songs!),
                    ),
                    input: ({ context }) => context,
                  },
                  {
                    id: 'announcerGeneratingMessage',
                    src: announcerMessageMachine,
                    input: ({ context }) => ({
                      channel: context.channels!.processing,
                      round: context.round!.fullId,
                      songs: context.songs!,
                    }),
                    onDone: {
                      target: 'generatingExtraAnnouncers',
                      actions: raise({ type: 'START_STREAM' }),
                    },
                  },
                ],
              },
              generatingExtraAnnouncers: {
                invoke: {
                  id: 'extraAnnouncersGenerator',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    input.extraAnnouncer!.process(input.round!.dirs.extraAnnouncer),
                  ),
                  input: ({ context }) => context,
                  onDone: {
                    target: 'idle',
                    actions: assign(({ event }) => ({
                      outroAnnouncer: event.output.find((a: ExtraAnnouncer) => a.id === 'outro'),
                    })),
                  },
                },
              },
              idle: {
                on: {
                  REFETCH: {
                    target: 'fetching',
                    actions: assign(({ context, event }) => ({
                      channels: { ...context.channels!, processing: event.channel },
                    })),
                  },
                },
              },
            },
          },
          streaming: {
            initial: 'idle',
            states: {
              idle: {
                on: { START_STREAM: { target: 'setupNodeshout' } },
              },
              setupNodeshout: {
                invoke: {
                  src: 'initNodeshout',
                  input: ({ context }) => context,
                },
                on: {
                  PLAY_STREAM: {
                    target: 'playingIntro',
                    actions: assign(({ event }) => ({ _shout: event._shout })),
                  },
                  ERROR_OPENING_STREAM: {
                    actions: raise({ type: 'STOP' }),
                  },
                },
              },
              playingIntro: {
                entry: [
                  assign(() => ({ abortController: new AbortController() })),
                  ({ context }) => startIntroMessage(context.channels!.party),
                ],
                invoke: {
                  id: 'playIntro',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    playIntro(input._shout!, input.abortController!),
                  ),
                  input: ({ context }) => context,
                  onDone: { target: 'pickNextSong' },
                },
                on: {
                  SKIP_SONG: {
                    actions: ({ context }) => context.abortController?.abort(),
                  },
                },
              },
              pickNextSong: {
                entry: 'setCurrentAndNextSong',
                always: [
                  { target: 'playingSong', guard: ({ context }) => context.currentSong !== null },
                  { target: 'playingOutro' },
                ],
              },
              playingSong: {
                entry: [
                  assign(() => ({ abortController: new AbortController() })),
                  ({ context }) =>
                    playCurrentSongMessage({
                      channel: context.channels!.party,
                      currentSong: context.currentSong!,
                      songs: context.songs!,
                      round: context.round!.fullId,
                    }),
                ],
                invoke: {
                  id: 'playCurrentSong',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    playCurrentSong(input._shout!, input.currentSong!, input.abortController!),
                  ),
                  input: ({ context }) => context,
                  onDone: { target: 'pickNextSong' },
                },
                on: {
                  SKIP_SONG: {
                    actions: ({ context }) => context.abortController?.abort(),
                  },
                },
              },
              playingOutro: {
                entry: assign(() => ({ abortController: new AbortController() })),
                invoke: {
                  id: 'playOutro',
                  src: fromPromise(({ input }: { input: PartyContext }) =>
                    playOutro(input._shout!, input.outroAnnouncer!, input.abortController!),
                  ),
                  input: ({ context }) => context,
                  onDone: { actions: raise({ type: 'STOP' }) },
                },
              },
            },
          },
        },
      },
      stopping: {
        entry: 'cleanup',
        invoke: {
          id: 'stopPartyMessage',
          src: fromPromise(
            ({ input }: { input: { context: PartyContext; immediate: boolean } }) => {
              if (input.immediate) {
                return stopPartyMessage(input.context.channels!.party);
              } else {
                return partyConcludedMessage(input.context.channels!.party);
              }
            },
          ),
          input: ({ context, event }) => ({
            context,
            immediate: (event as Extract<PartyEvent, { type: 'STOP' }>).immediate ?? false,
          }),
          onDone: { target: 'idle' },
          onError: { target: 'idle' },
        },
      },
    },
  },
  {
    actions: {
      makeRoundDirectories: ({ context }) => makeRoundDirectories(context.round!.dirs),
      setRoundContext: assign(({ event }) => {
        const ev = event as Extract<PartyEvent, { type: 'START' }>;
        const { id, prefix } = roundPrefixAndId(ev.round);
        const parent = path.join(process.cwd(), 'tmp', 'rounds', ev.round);
        return {
          channels: { processing: ev.channel, party: ev.channel } as any,
          round: {
            fullId: ev.round,
            id,
            prefix,
            title: roundTitle(prefix, id) ?? ev.round,
            dirs: {
              parent,
              download: path.join(parent, 'download'),
              transcode: path.join(parent, 'transcode'),
              announcer: path.join(parent, 'announcer'),
              extraAnnouncer: path.join(parent, 'extraAnnouncer'),
            },
          },
        };
      }),
      cleanup: ({ context }) => {
        if (context.abortController) {
          console.log('Aborting the current audio pipeline');
          context.abortController.abort();
        }
        if (context._shout) {
          console.log('Closing nodeshout connection');
          context._shout.close();
        }
      },
      setCurrentAndNextSong: assign(({ context }) => {
        if (!context.currentSong && !context.nextSongId) {
          const [first, second] = context.songs!;
          return { currentSong: first, nextSongId: second ? second.id : null };
        } else if (!context.nextSongId) {
          return { currentSong: null };
        } else {
          const previousSongIndex = context.songs!.findIndex(
            (song) => song.id === context.currentSong!.id,
          );
          const songIndex = context.songs!.findIndex((song) => song.id === context.nextSongId);

          if (songIndex === -1 && previousSongIndex === -1) {
            const [first, second] = context.songs!;
            return { currentSong: first, nextSongId: second ? second.id : null };
          } else if (songIndex === -1) {
            const song = context.songs![previousSongIndex + 1];
            const next = context.songs![previousSongIndex + 2];
            return { currentSong: song, nextSongId: next ? next.id : null };
          } else {
            const next = context.songs![songIndex + 1];
            return { currentSong: context.songs![songIndex], nextSongId: next ? next.id : null };
          }
        }
      }),
    },
    actors: {
      initNodeshout: fromCallback<any, PartyContext>(({ sendBack, input }) => {
        const shout: ShoutT = nodeshout.create();
        shout.setHost(STREAM.host);
        shout.setPort(STREAM.port);
        shout.setUser('source');
        shout.setPassword(STREAM.password);
        shout.setMount(STREAM.mount);
        shout.setFormat(1);
        shout.setName(`${input.round?.fullId} Listening Party`);
        shout.setAudioInfo('bitrate', '320');
        shout.setAudioInfo('samplerate', '44100');
        shout.setAudioInfo('channels', '2');

        const errorCode = shout.open();

        if (errorCode === nodeshout.ErrorTypes.SUCCESS) {
          sendBack({ type: 'PLAY_STREAM', _shout: shout });
        } else {
          sendBack({ type: 'ERROR_OPENING_STREAM', errorCode });
        }

        return () => {};
      }),
    },
  },
);

export const partyService = createActor(machine).start();

partyService.subscribe((snapshot) => {
  console.log('Party service transition:', JSON.stringify(snapshot.value));
});
