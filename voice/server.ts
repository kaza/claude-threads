/**
 * voice-desk entry point. Reads the env, builds the app, ends stale call
 * cards from a previous life, starts the idle reaper, listens.
 * See docs/voice-desk-spec.md § Deployment.
 */

import { homedir } from 'os';
import { join, resolve } from 'path';
import { createApp } from './app.js';
import { Calls } from './calls.js';
import { DEFAULT_LIVE_MODEL } from './gemini.js';
import { createStore } from './session.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`voice-desk: ${name} is required`);
    process.exit(2);
  }
  return value;
}

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const publicUrl = required('PUBLIC_URL').replace(/\/+$/, '');
const basePath = (process.env.BASE_PATH ?? new URL(publicUrl).pathname).replace(/\/+$/, '');
const configDir = process.env.VOICE_DESK_DIR ?? join(homedir(), '.config', 'voice-desk');
const store = await createStore(join(configDir, 'state.json'));
const slack = { fetch };

const calls = new Calls({
  store,
  slack,
  gemini: { apiKey: required('GEMINI_API_KEY'), fetch, now: () => new Date() },
  botUserId: required('SLACK_BOT_USER_ID'),
  publicUrl,
  model: process.env.GEMINI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL,
  voiceName: process.env.GEMINI_VOICE ?? 'Aoede',
  now: () => Date.now(),
  log,
  onTokenDead: (userId) => void store.update((s) => { delete s.users[userId]; }).then(() => log(`user=${userId} token dead, removed`)),
});

const app = createApp({
  basePath,
  publicUrl,
  slack,
  slackClientId: required('SLACK_CLIENT_ID'),
  slackClientSecret: required('SLACK_CLIENT_SECRET'),
  slackTeamId: required('SLACK_TEAM_ID'),
  store,
  sessionSecret: required('SESSION_SECRET'),
  calls,
  channels: { slack, bindingsFile: required('DYNAMIC_CHANNELS_FILE') },
  publicDir: resolve(import.meta.dir, 'public'),
  log,
});

await calls.bootCleanup();
calls.startReaper();

const hostname = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
Bun.serve({ hostname, port, fetch: (req) => app.fetch(req) });
log(`voice-desk listening on ${hostname}:${port}, public ${publicUrl}, model ${process.env.GEMINI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping`);
    calls.stop();
    process.exit(0);
  });
}
