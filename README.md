# Chorus

Chorus is a Discord bot — the "party rock commander" for [Compoverse](https://compo.thasauce.net), ThaSauce's music composition community. It runs listening parties: fetches a competition round's entries, transcodes them, generates AI voice announcements via AWS Polly, and streams the whole show out over Icecast, all coordinated through a handful of Discord slash commands.

## Stack

TypeScript (ESM, `nodenext`) · Node 24 · @sapphire/framework v5 · discord.js v14 · XState v5 · nodeshout (Icecast) · AWS Polly · Vitest

## Running it locally

Prereqs:

- [mise](https://mise.jdx.dev) — pins Node 24 and Yarn 4, manages env defaults, and runs project tasks. Install per the mise docs and add `eval "$(mise activate zsh)"` (or your shell's equivalent) to your shell rc so mise auto-loads on `cd` into the repo.
- [fnox](https://fnox.jdx.dev) — pulls secrets from 1Password and caches them locally age-encrypted. See "Environment" below for the full setup.

```bash
mise install                # installs Node + Yarn
yarn install
op signin                   # see "Environment" below for prereqs
mise run secrets:sync       # populates fnox.local.toml from 1Password
mise run dev                # tsx watch src/index.ts — live reload
```

For a production-like run:

```bash
mise run build
mise run start
```

Both `yarn <script>` and `mise run <task>` work for project commands. Node and Yarn versions are pinned by `mise.toml`; `package.json`'s `engines.node` and `packageManager` fields exist for Heroku.

### Environment

Secrets live in 1Password and are cached locally via fnox; non-secret defaults (AWS region, Icecast host, etc.) live in `mise.toml`'s `[env]` block. The bot reads everything straight from `process.env`.

Prereqs:

- 1Password account, with a `Development` vault containing an item named `chorus` whose fields hold the secrets listed in `fnox.toml` (field names are underscored, lowercased env-var names — e.g., `hubot_discord_token`).
- 1Password CLI: `brew install 1password-cli`.
- 1Password 8 desktop app with CLI integration enabled (Settings → Developer).
- `op account add` once, so `op signin` works.
- fnox: `brew install fnox`.
- In `.zshrc`:
  ```zsh
  eval "$(fnox activate zsh)"
  export FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt"
  ```
- An age private key at `~/.config/fnox/age.txt` (`age-keygen -o ~/.config/fnox/age.txt`; back up the private key in your personal 1Password vault). Add the public key to `fnox.toml`'s `recipients` array.

First-time clone:

```bash
op signin                   # Touch ID prompt
mise run secrets:sync       # populates fnox.local.toml
mise run dev
```

After `secrets:sync` everything reads from the local age cache — no 1Password calls per run. Re-run `op signin` then `mise run secrets:sync` whenever a secret rotates in 1Password.

Required secrets (fields on the `chorus` 1Password item):

- `hubot_discord_token` — bot token from the Discord developer portal
- `guild_id` — Discord guild the slash commands register against (Chorus is guild-only, not global)
- `debug_channel_id` — channel for the bot's debug log stream
- `aws_access_key_id`, `aws_secret_access_key` — AWS credentials for Polly TTS
- `hubot_stream_source_password` — Icecast source-client password

Non-secret defaults (`AWS_REGION`, `HUBOT_STREAM_HOST`, `HUBOT_STREAM_PORT`, `HUBOT_STREAM_MOUNT`, `AWS_NODEJS_CONNECTION_REUSE_ENABLED`) are set in `mise.toml`'s `[env]` block.

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
