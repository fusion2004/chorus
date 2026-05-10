/**
 * Shared protocol between partyService and the streaming child machines
 * (icecastMachine, muxMachine). Both machines accept the same input shape and
 * exchange the same set of events, so the parent stays backend-agnostic.
 *
 * Lifecycle (parent perspective):
 *   parent spawns child  →  child sits idle (does not open the wire yet)
 *   parent → CONNECT     →  child opens its connection, emits READY (with url)
 *   parent → PLAY_INTRO  →  child emits INTRO_DONE
 *   parent → PLAY_SONG   →  child emits SONG_STARTED   (after announcer, before song audio)
 *                        →  child emits SONG_DONE
 *   parent → PLAY_OUTRO  →  child emits OUTRO_DONE
 *   parent → STOP        →  child closes connection and stops
 *
 * The CONNECT step is explicit so the child doesn't open a libshout / SRT
 * connection while round processing is still running (matches today's
 * behaviour of opening the wire only after announcer generation finishes).
 *
 * SKIP_SONG can interrupt PLAY_SONG at any point; the child should abort the
 * current file mid-write and emit SONG_DONE so the parent advances normally.
 *
 * The Discord "now playing" message in partyService fires on SONG_STARTED so
 * its timing aligns with what listeners actually hear (announcer first, then
 * song — and the message lands at song-start, not announcer-start).
 */

import type { Song } from '../song.js';

export type StreamingMode = 'icecast' | 'mux';

/** A static announcer file produced by RoundExtraAnnouncer (e.g. the outro). */
export interface ExtraAnnouncer {
  id: string;
  path: string;
}

/** Events the parent sends down into a streaming child machine. */
export type StreamingInputEvent =
  | { type: 'CONNECT' }
  | { type: 'PLAY_INTRO' }
  | { type: 'PLAY_SONG'; song: Song }
  | { type: 'PLAY_OUTRO'; announcer: ExtraAnnouncer }
  | { type: 'SKIP_SONG' }
  | { type: 'STOP' };

/** Events a streaming child machine emits up to the parent. */
export type StreamingOutputEvent =
  | { type: 'READY'; url: string }
  | { type: 'INTRO_DONE' }
  | { type: 'SONG_STARTED' }
  | { type: 'SONG_DONE' }
  | { type: 'OUTRO_DONE' }
  | { type: 'ERROR'; reason: string };

/** Input shape both streaming machines accept at spawn time. */
export interface StreamingInput {
  round: { fullId: string };
}
