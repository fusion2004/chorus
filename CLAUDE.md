# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chorus is a Discord bot and the "party rock commander" for Compoverse (ThaSauce music composition community). It runs listening parties where it streams competition entries over Icecast with AI-generated voice announcements (AWS Polly), coordinated through Discord slash commands.

## Commands

```bash
yarn dev            # Live-reload dev: tsx watch src/index.ts
yarn build          # Compile TypeScript (src/ → dist/)
yarn start          # Run the built bot: node dist/index.js
yarn test           # Run the Vitest suite once
yarn test:watch     # Vitest in watch mode
yarn test:coverage  # Vitest with v8 coverage
yarn lint           # oxlint + oxfmt --check, in parallel
yarn lint:fix       # Auto-fix lint/format issues
npx tsc --noEmit    # Type-check without emitting (fast validation)
```

Deployed via Heroku (`Procfile: bot: yarn start`). The Heroku Node buildpack runs `yarn build` automatically during the build phase, so `yarn start` just runs the already-compiled `dist/index.js` at dyno boot. There is no pre-built `dist/` committed.

CI runs lint + build + test on push and PR via `.github/workflows/ci.yml` (uses `volta-cli/action` to pin Node and Yarn to the versions in `package.json`'s `volta` field).

## Architecture

**Stack:** TypeScript (ESM, `nodenext`), @sapphire/framework v5, discord.js v14, XState v5, nodeshout (Icecast streaming), AWS Polly (TTS), Vitest (tests)

### Sapphire Auto-Discovery

Sapphire discovers commands, listeners, and preconditions relative to `dist/index.js`:
- `dist/commands/compoverse/` — slash commands (`startparty`, `stopparty`, `skipsong`, `playlist`, `refetchparty`, `votejarski`)
- `dist/listeners/` — event handlers (e.g., ready)
- `dist/preconditions/` — authorization checks (`CompoAdminOnly`)

All slash commands are guild-specific (registered to `GUILD_ID`, not global).

### State Machine Core (XState v5)

The bot is driven by XState v5 actors. The main flow:

1. **`partyService`** (`src/lib/party.ts`) — the central actor, manages the entire listening party lifecycle. Has parallel states for `processing` (fetch/transcode/announce) and `streaming` (audio playback). Largest and most complex file (~880 lines).

2. **`songMachine`** (`src/lib/machines.ts`) — tracks each song through: `init` → `fetched` → `downloading` → `downloaded` → `transcoding` → `transcoded` → `announcerProcessing` → `ready`

3. **`debugChannelMachine`** (`src/lib/logger.ts`) — debounced message batching for the Discord debug channel.

The `Song` class (`src/lib/song.ts`) wraps a `songMachine` actor instance and exposes state via `getSnapshot()`.

### Audio Pipeline

For each song in a round: fetch metadata from ThaSauce → download MP3 → transcode via FFmpeg (prism-media) → generate TTS announcer (AWS Polly, via `src/lib/polly.ts`) → stream to Icecast via nodeshout's manual chunk loop (`streamFile` helper in party.ts).

`src/lib/polly.ts` is the single integration point for AWS Polly — it owns the shared `PollyClient`, the `SynthesizeSpeechCommand` settings (voice, engine, sample rate, format), the SSML envelope (`buildSsml`), and the synthesize-to-file helper. Both `RoundAnnouncer` and `RoundExtraAnnouncer` consume it; nothing else should touch `@aws-sdk/client-polly` directly.

### Error Handling in `partyService`

Every `fromPromise` actor that touches an external system has an `onError` handler that calls `logActorError(prefix)` (defined at the top of `party.ts`) and then `raise({ type: 'STOP' })`. This forwards the error to the debug channel and winds the party down cleanly instead of crashing the bot. New external-touching actors should follow this pattern.

### Key Patterns

- **XState v5 syntax:** `createActor()`, `getSnapshot().matches()`, `assign(({ context, event }) => ...)`, `fromPromise()`, `fromCallback()`, `raise({ type: 'EVENT' })`
- **Ambient type shims:** `src/types/shims.d.ts` provides declarations for untyped packages (nodeshout, prism-media)
- **Environment variables:** All required env vars are accessed via `fetchEnv()` from `src/utils/fetch-env.ts`, which throws if missing. `fetchEnvironment()` returns NODE_ENV with a 'development' fallback. See `.env.sample` for the full list.

## Testing

Tests live under `test/` (kept out of `src/` so Sapphire's auto-discovery doesn't try to load them as commands/preconditions):

```
test/
  helpers/{interaction,run-command,sapphire}.ts
  utils/*.test.ts
  lib/*.test.ts
  preconditions/*.test.ts
  commands/compoverse/*.test.ts
```

Path aliases: `@src/*` and `@test/*` are configured in both `tsconfig.json` (`compilerOptions.paths`) and `vitest.config.ts` (`resolve.alias`). Imports look like `import { foo } from '@src/lib/foo.js'` — no `../../../src/` chains.

**How command tests work.** They drive commands through real Sapphire machinery, not a hand-rolled approximation:

1. `test/helpers/sapphire.ts` bootstraps the real `PreconditionStore`, `CommandStore`, and `ListenerStore` once (memoized) and assigns a `FakeSapphireClient` (an `EventEmitter` subclass whose `emit` captures into an array) to `container.client`.
2. Each test calls `await registerForTest({ preconditions: [...], command: { name, piece } })` in `beforeAll` to load its dependencies into the real stores via `Store.loadPiece` and get back the constructed command instance.
3. `runCommand(command, interaction)` invokes the real `CorePreChatInputCommandRun` listener, reads the captured `Accepted`/`Denied` emit, and on success invokes the real `CoreChatInputCommandAccepted` listener (which calls `command.chatInputRun`). Returns `{ ran, blockedBy, deniedBy, emits }`.

This means the same `PreconditionContainerArray` → `PreconditionContainerSingle` → store-lookup path that runs in production also runs in tests.

`vi.mock('@src/lib/party.js', ...)` and `vi.mock('@src/lib/logger.js', ...)` replace the heavy module-level singletons in command tests so we don't pull in nodeshout, AWS, etc.
