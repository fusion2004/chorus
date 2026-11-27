import { defineRailway, github, preserve, project, service } from 'railway/iac';

// Only manage what this file declares. akatosh, nightly-restart, and chorus-icecast live in the same project, under
// their own config (or the dashboard).
export const partial = 'chorus';

export default defineRailway(() => {
  const chorus = service('chorus', {
    source: github('fusion2004/chorus', { branch: 'main' }),
    // Built by Railpack from railpack.json, which installs FFmpeg from our apt repo
    build: { builder: 'RAILPACK' },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 1_000_000_000 } },
    },
    // Any variable not declared here is deleted on the next apply. This repo is public, so secret values live only on
    // Railway (set them in the dashboard) and are kept with preserve().
    env: {
      AWS_REGION: 'us-east-1',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),

      HUBOT_DISCORD_TOKEN: preserve(),
      GUILD_ID: preserve(),
      DEBUG_CHANNEL_ID: preserve(),

      // Icecast streaming (src/lib/streaming/icecast.ts)
      HUBOT_STREAM_HOST: 'chorus.thasauce.net',
      HUBOT_STREAM_PORT: '8000',
      HUBOT_STREAM_MOUNT: 'compo',
      HUBOT_STREAM_SOURCE_PASSWORD: preserve(),
      ICECAST_ORIGIN: 'http://chorus.thasauce.net:8000',

      // Mux streaming (src/lib/streaming/mux.ts)
      MUX_TOKEN_ID: preserve(),
      MUX_TOKEN_SECRET: preserve(),

      // The libsrt tag @eyevinn/srt builds against at install time
      NODE_SRT_CHECKOUT: 'v1.5.5',
    },
  });

  return project('main', { resources: [chorus] });
});
