import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import { createMachine, createActor, assign, raise, fromPromise, sendTo } from 'xstate';
import type { ActorRef } from 'xstate';
import type { TextChannel, Message } from 'discord.js';
import { EmbedBuilder } from 'discord.js';

import CompoThaSauceFetcher from './compo-thasauce-fetcher.js';
import { Song } from './song.js';
import { RoundFetcher } from './round-fetcher.js';
import { RoundTranscoder } from './round-transcoder.js';
import { RoundAnnouncer } from './round-announcer.js';
import { RoundExtraAnnouncer } from './round-extra-announcer.js';
import { icecastMachine } from './streaming/icecast.js';
import { muxMachine } from './streaming/mux.js';
import type { ExtraAnnouncer, StreamingMode, StreamingOutputEvent } from './streaming/types.js';
import { transcodeFinal } from '../utils/symbols.js';
import { xstateTags } from '../utils/xstate-tags.js';
import { logger, debugError } from './logger.js';

// Action factory for XState onError handlers: pulls the error message off the
// invoke's error event and forwards it to the debug-channel logger.
function logActorError(prefix: string) {
  return ({ event }: { event: unknown }) => {
    const err = (event as { error?: unknown }).error;
    const message = (err as { message?: string })?.message ?? String(err);
    debugError(`${prefix}: ${message}`);
  };
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
      const metadata = await parseFile(song.path(transcodeFinal));
      song.service.send({ type: 'UPDATE_METADATA', metadata });
    }),
  );
}

function startFetchMessage(channel: TextChannel, round: string): void {
  channel.send(`*Gathering round ${round} metadata...*`);
}

function fetchErrorMessage(channel: TextChannel): Promise<Message> {
  return channel.send(`There was an error fetching the round.`);
}

async function startIntroMessage(channel: TextChannel, streamUrl: string): Promise<void> {
  await channel.send(`**Starting stream... ${streamUrl}**`);
  await channel.send('**Playing stream intro before we get this party started...**');
}

async function playCurrentSongMessage({
  channel,
  currentSong,
  songs,
  round,
  streamUrl,
}: {
  channel: TextChannel;
  currentSong: Song;
  songs: Song[];
  round: string;
  streamUrl: string;
}): Promise<void> {
  const index = songs.findIndex((song) => song.id === currentSong.id);
  const position = index + 1;

  const embed = new EmbedBuilder()
    .setColor(0x39aa6e)
    .setTitle(currentSong.safeTitle)
    .setURL(`http://compo.thasauce.net/rounds/view/${round}#entry-${currentSong.id}`)
    .setDescription(
      `${round} listening party, entry ${position} of ${songs.length}.\n[Tune in to the stream here!](${streamUrl})`,
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

interface PartyContext {
  channels?: { processing: TextChannel; party: TextChannel };
  round?: RoundInfo;
  streamTo?: StreamingMode;
  /** URL the streaming child reports back via READY; embedded in Discord messages. */
  streamUrl?: string;
  /**
   * Ref to the spawned streaming child machine (icecastMachine | muxMachine).
   * Only used so XState doesn't garbage-collect the actor — we communicate
   * via sendTo('streamer', …) by id rather than via this ref.
   */
  streamerRef?: ActorRef<any, any>;
  fetcher?: CompoThaSauceFetcher;
  downloader?: RoundFetcher;
  transcoder?: RoundTranscoder;
  announcer?: RoundAnnouncer;
  extraAnnouncer?: RoundExtraAnnouncer;
  fetchedSongs?: any[];
  songs?: Song[];
  currentSong?: Song | null;
  nextSongId?: string | null;
  outroAnnouncer?: ExtraAnnouncer;
}

type PartyEvent =
  | { type: 'START'; channel: TextChannel; round: string; streamTo: StreamingMode }
  | { type: 'STOP'; immediate?: boolean }
  | { type: 'SKIP_SONG' }
  | { type: 'REFETCH'; channel: TextChannel }
  | { type: 'START_STREAM' }
  // Events emitted by the streaming child machine — see streaming/types.ts
  | StreamingOutputEvent;

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
  streamTo: StreamingMode,
): Song[] {
  const existing = currentSongs ?? [];
  return fetchedSongs.map((songData) => {
    let song = existing.find((s) => s.id === songData.id);
    if (!song) {
      song = new Song(roundDir, streamTo);
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
          streamTo: undefined,
          streamUrl: undefined,
          streamerRef: undefined,
          fetcher: undefined,
          downloader: undefined,
          announcer: undefined,
          fetchedSongs: undefined,
          songs: undefined,
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
        entry: assign(({ context, spawn }) => ({
          fetcher: new CompoThaSauceFetcher(context.round!.fullId),
          downloader: new RoundFetcher(),
          transcoder: new RoundTranscoder(context.streamTo!),
          announcer: new RoundAnnouncer(context.round!.title, context.streamTo!),
          extraAnnouncer: new RoundExtraAnnouncer(context.round!.title, context.streamTo!),
          // Spawn the streaming child machine for the chosen backend. It sits
          // in `idle` until we send CONNECT (after announcer generation
          // finishes, matching today's "open the wire after processing" flow).
          streamerRef: spawn(context.streamTo === 'mux' ? muxMachine : icecastMachine, {
            id: 'streamer',
            input: { round: { fullId: context.round!.fullId } },
          }),
        })),
        // STOP is sent both intentionally (slash command, party concluded) and
        // raised internally on errors. Either way, transition to `stopping`
        // and have it tell the streamer to tear itself down.
        exit: sendTo('streamer', { type: 'STOP' }),
        type: 'parallel',
        on: {
          STOP: { target: 'stopping' },
          // /skipsong — forward to the streamer, which decides what aborts.
          SKIP_SONG: { actions: sendTo('streamer', { type: 'SKIP_SONG' }) },
        },
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
                          context.streamTo!,
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
                    onError: {
                      actions: [logActorError('Round download failed'), raise({ type: 'STOP' })],
                    },
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
                    onError: {
                      actions: [logActorError('Round transcode failed'), raise({ type: 'STOP' })],
                    },
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
                  onError: {
                    actions: [logActorError('Metadata parsing failed'), raise({ type: 'STOP' })],
                  },
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
                    onError: {
                      actions: [
                        logActorError('Announcer generation failed'),
                        raise({ type: 'STOP' }),
                      ],
                    },
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
                  onError: {
                    actions: [
                      logActorError('Extra announcer generation failed'),
                      raise({ type: 'STOP' }),
                    ],
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
            // Hard errors from the streaming child. Treat them as a request to
            // wind the party down — same policy as actor onError elsewhere.
            on: {
              STREAM_ERROR: {
                actions: [
                  ({ event }) => debugError(`Streamer error: ${event.reason}`),
                  raise({ type: 'STOP' }),
                ],
              },
            },
            states: {
              idle: {
                // Processing pipeline raises START_STREAM after announcer
                // generation finishes; we forward CONNECT to the streamer so
                // it opens the wire only once everything's ready.
                on: {
                  START_STREAM: {
                    target: 'connecting',
                    actions: sendTo('streamer', { type: 'CONNECT' }),
                  },
                },
              },
              connecting: {
                on: {
                  STREAM_READY: {
                    target: 'playingIntro',
                    actions: [
                      assign(({ event }) => ({ streamUrl: event.url })),
                      ({ context, event }) => startIntroMessage(context.channels!.party, event.url),
                      sendTo('streamer', { type: 'PLAY_INTRO' }),
                    ],
                  },
                },
              },
              playingIntro: {
                on: {
                  STREAM_INTRO_DONE: { target: 'pickNextSong' },
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
                entry: sendTo('streamer', ({ context }) => ({
                  type: 'PLAY_SONG',
                  song: context.currentSong!,
                })),
                on: {
                  // The streamer emits SONG_STARTED once the announcer is done
                  // and song audio is starting — that's when we post the "Now
                  // Playing" embed so its timing matches what listeners hear.
                  STREAM_SONG_STARTED: {
                    actions: ({ context }) =>
                      playCurrentSongMessage({
                        channel: context.channels!.party,
                        currentSong: context.currentSong!,
                        songs: context.songs!,
                        round: context.round!.fullId,
                        streamUrl: context.streamUrl!,
                      }),
                  },
                  STREAM_SONG_DONE: { target: 'pickNextSong' },
                },
              },
              playingOutro: {
                entry: sendTo('streamer', ({ context }) => ({
                  type: 'PLAY_OUTRO',
                  announcer: context.outroAnnouncer!,
                })),
                on: {
                  STREAM_OUTRO_DONE: { actions: raise({ type: 'STOP' }) },
                },
              },
            },
          },
        },
      },
      stopping: {
        // No explicit cleanup action here — partying.exit already sent STOP
        // to the streamer, which handles its own libshout/SRT teardown.
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
          streamTo: ev.streamTo,
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
  },
);

export const partyService = createActor(machine).start();

partyService.subscribe((snapshot) => {
  logger.info({ tags: xstateTags('party', snapshot.value) }, 'Party service transition');
});
