# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chorus is a Discord bot and the "party rock commander" for Compoverse (ThaSauce music composition community). It runs listening parties where it streams competition entries over Icecast with AI-generated voice announcements (AWS Polly), coordinated through Discord slash commands.

## Commands

```bash
yarn build          # Compile TypeScript (src/ → dist/)
yarn start          # Build + run: tsc && node dist/index.js
npx tsc --noEmit    # Type-check without emitting (fast validation)
yarn lint           # Run oxlint + oxfmt check in parallel
yarn lint:fix       # Auto-fix lint/format issues
```

Deployed via Heroku (`Procfile: bot: yarn start`). TypeScript compiles on every deploy — there is no pre-built dist/ committed.

## Architecture

**Stack:** TypeScript (CommonJS), @sapphire/framework v5, discord.js v14, XState v5, nodeshout (Icecast streaming), AWS Polly (TTS)

### Sapphire Auto-Discovery

Sapphire discovers commands, listeners, and preconditions relative to `dist/index.js`:
- `dist/commands/compoverse/` — slash commands
- `dist/listeners/` — event handlers (e.g., ready)
- `dist/preconditions/` — authorization checks (CompoAdminOnly)

All slash commands are guild-specific (registered to `GUILD_ID`, not global).

### State Machine Core (XState v5)

The bot is driven by XState v5 actors. The main flow:

1. **`partyService`** (`src/lib/party.ts`) — the central actor, manages the entire listening party lifecycle. Has parallel states for `processing` (fetch/transcode/announce) and `streaming` (audio playback). This is the largest and most complex file (~850 lines).

2. **`songMachine`** (`src/lib/machines.ts`) — tracks each song through: `init` → `fetched` → `downloading` → `downloaded` → `transcoding` → `transcoded` → `announcerProcessing` → `ready`

3. **`debugChannelMachine`** (`src/lib/logger.ts`) — debounced message batching for the Discord debug channel

The `Song` class (`src/lib/song.ts`) wraps a `songMachine` actor instance and exposes state via `getSnapshot()`.

### Audio Pipeline

For each song in a round: fetch metadata from ThaSauce → download MP3 → transcode via FFmpeg (prism-media) → generate TTS announcer (AWS Polly) → stream to Icecast via nodeshout's manual chunk loop (`streamFile` helper in party.ts).

### Key Patterns

- **XState v5 syntax:** `createActor()`, `getSnapshot().matches()`, `assign(({ context, event }) => ...)`, `fromPromise()`, `fromCallback()`, `raise({ type: 'EVENT' })`
- **CommonJS constraint:** `got@11` and `music-metadata@7` are pinned because later versions are ESM-only. `chalk@4` is also pinned for the same reason. Do not upgrade these.
- **Ambient type shims:** `src/types/shims.d.ts` provides declarations for untyped packages (nodeshout, prism-media, zippa)
- **Environment variables:** All required env vars are accessed via `fetchEnv()` from `src/utils/fetch-env.ts`, which throws if missing. See `.env.sample` for the full list.
