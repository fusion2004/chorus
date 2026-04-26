# Chorus

Chorus is a Discord bot — the "party rock commander" for [Compoverse](https://compo.thasauce.net), ThaSauce's music composition community. It runs listening parties: fetches a competition round's entries, transcodes them, generates AI voice announcements via AWS Polly, and streams the whole show out over Icecast, all coordinated through a handful of Discord slash commands.

## Stack

TypeScript (ESM, `nodenext`) · Node 24 · @sapphire/framework v5 · discord.js v14 · XState v5 · nodeshout (Icecast) · AWS Polly · Vitest

## Running it locally

Prereqs:

- [mise](https://mise.jdx.dev) — pins Node 24 and Yarn 4, manages env vars, and runs project tasks. Install per the mise docs and add `eval "$(mise activate zsh)"` (or your shell's equivalent) to your shell rc so mise auto-loads on `cd` into the repo.

```bash
mise install                                # installs Node + Yarn
yarn install
cp mise.local.toml.sample mise.local.toml   # fill in the blanks; see "Environment" below
mise run dev                                # tsx watch src/index.ts — live reload
```

For a production-like run:

```bash
mise run build
mise run start
```

Both `yarn <script>` and `mise run <task>` work for project commands. Node and Yarn versions are pinned by `mise.toml`; `package.json`'s `engines.node` and `packageManager` fields exist for Heroku.

### Environment

Copy `mise.local.toml.sample` to `mise.local.toml` and fill in the blanks. mise auto-loads it when you `cd` into the repo. Required variables:

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
