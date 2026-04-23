# Chorus

Chorus is a Discord bot — the "party rock commander" for [Compoverse](https://compo.thasauce.net), ThaSauce's music composition community. It runs listening parties: fetches a competition round's entries, transcodes them, generates AI voice announcements via AWS Polly, and streams the whole show out over Icecast, all coordinated through a handful of Discord slash commands.

## Stack

TypeScript (ESM, `nodenext`) · Node 24 · @sapphire/framework v5 · discord.js v14 · XState v5 · nodeshout (Icecast) · AWS Polly · Vitest

## Running it locally

Prereqs:

- Node 24 and Yarn 4 — Volta will pin these for you (see `package.json`'s `volta` field).
- [direnv](https://direnv.net/) — the bot reads env vars straight from `process.env`, so something needs to load them into your shell. direnv + an `.envrc` is the recommended setup; anything equivalent (manual `export`s, a shell profile, your shell's secrets manager) works too.

```bash
yarn install
cp .envrc.sample .envrc   # fill in the blanks; see "Environment" below
direnv allow              # authorize the .envrc
yarn dev                  # tsx watch src/index.ts — live reload
```

For a production-like run:

```bash
yarn build
yarn start
```

### Environment

Copy `.envrc.sample` to `.envrc` and fill in the blanks, then `direnv allow`. Required variables:

- `HUBOT_DISCORD_TOKEN` — bot token from the Discord developer portal
- `GUILD_ID` — Discord guild the slash commands register against (Chorus is guild-only, not global)
- `DEBUG_CHANNEL_ID` — channel for the bot's debug log stream
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — AWS credentials for Polly TTS
- `HUBOT_STREAM_HOST`, `HUBOT_STREAM_PORT`, `HUBOT_STREAM_MOUNT`, `HUBOT_STREAM_SOURCE_PASSWORD` — Icecast endpoint and source-client password

## Tests

```bash
yarn test            # run once
yarn test:watch      # watch mode
yarn test:coverage   # with v8 coverage
```

Tests live under `test/` and run through the real Sapphire listener pipeline. See `CLAUDE.md` for details.

## Lint and typecheck

```bash
yarn lint            # oxlint + oxfmt --check
yarn lint:fix        # auto-fix
yarn build           # also serves as a typecheck (tsc with emit)
```

CI (`.github/workflows/ci.yml`) runs lint + build + test on push and PR.

## Deploy

Deployed to Heroku. The Node buildpack runs `yarn build` during the build phase (no pre-built `dist/` is committed), and the `Procfile` runs `yarn start` at dyno boot to execute the compiled `dist/index.js`.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for a tour of the state-machine layout, audio pipeline, and testing conventions.
