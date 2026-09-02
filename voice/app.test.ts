/**
 * voice-desk: the HTTP surface end to end, in memory.
 * See docs/voice-desk-spec.md tests 1–3, 5, 11.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OAUTH_COOKIE, SESSION_COOKIE, createApp } from './app.js';
import { Calls } from './calls.js';
import { createCookieSigner, createStore, type Store } from './session.js';

const PUBLIC_URL = 'https://agents.vvs-capital.com/voice';
const ORIGIN = 'https://agents.vvs-capital.com';

function fakeSlack() {
  const recorded: Array<{ method: string; body: string }> = [];
  const queues: Record<string, unknown[]> = {};
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() as string;
    recorded.push({ method, body: String(init?.body ?? '') });
    const scripted = queues[method]?.shift();
    const defaults: Record<string, unknown> = {
      'oauth.v2.access': { ok: true, team: { id: 'T-VVS' }, authed_user: { id: 'U1', access_token: 'xoxp-1' } },
      'users.info': { ok: true, user: { real_name: 'Almir' } },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'fix-backfill', is_member: true }, { id: 'C9', name: 'general', is_member: true }], response_metadata: { next_cursor: '' } },
      'auth_tokens': { name: 'auth_tokens/tok', expireTime: 'x' },
      'calls.add': { ok: true, call: { id: 'R1' } },
      'chat.postMessage': { ok: true, ts: '1.1' },
      'calls.end': { ok: true },
      'conversations.history': { ok: true, messages: [] },
    };
    return new Response(JSON.stringify(scripted ?? defaults[method] ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, recorded, script: (m: string, a: unknown[]) => { queues[m] = a; } };
}

let dir: string;
let store: Store;
let slack: ReturnType<typeof fakeSlack>;
let app: ReturnType<typeof createApp>;
let calls: Calls;
const SECRET = 'a-session-secret-that-is-long-enough';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-app-'));
  store = await createStore(join(dir, 'state.json'));
  await mkdir(join(dir, 'public'));
  await writeFile(join(dir, 'public', 'index.html'), '<title>voice-desk</title>');
  slack = fakeSlack();
  calls = new Calls({
    store,
    slack: { fetch: slack.fn },
    gemini: { apiKey: 'g', fetch: slack.fn, now: () => new Date() },
    botUserId: 'UBOT',
    publicUrl: PUBLIC_URL,
    model: 'm',
    voiceName: 'Aoede',
    now: () => Date.now(),
    log: () => {},
    pollIntervalMs: 100_000,
    waitDeadlineMs: 20,
  });
  app = createApp({
    basePath: '/voice',
    publicUrl: PUBLIC_URL,
    slack: { fetch: slack.fn },
    slackClientId: 'cid',
    slackClientSecret: 'csecret',
    slackTeamId: 'T-VVS',
    store,
    sessionSecret: SECRET,
    calls,
    channels: { slack: { fetch: slack.fn }, bindingsFile: '/x.json', readFile: async () => JSON.stringify([{ channelId: 'C1', channelName: 'fix-backfill' }]) },
    publicDir: join(dir, 'public'),
    log: () => {},
    randomToken: () => 'nonce-1',
  });
});

afterEach(async () => {
  calls.stop();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`${ORIGIN}${path}`, { headers }));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers } }));

async function signedInCookie(userId = 'U1'): Promise<string> {
  await store.update((s) => { s.users[userId] = { userId, name: 'Almir', token: 'xoxp-1' }; });
  return `${SESSION_COOKIE}=${await createCookieSigner(SECRET).sign(userId)}`;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
}

describe('security headers and static files', () => {
  test('every response carries CSP, no-referrer, nosniff and no-store', async () => {
    const res = await get('/voice/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain('wss://generativelanguage.googleapis.com');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('the bare prefix redirects to the trailing-slash page', async () => {
    const res = await get('/voice');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC_URL}/`);
  });

  test('static files cannot escape the public directory', async () => {
    // The URL parser folds `..` away before routing; an encoded form reaches the handler and must still not serve.
    expect((await get('/voice/static/../state.json')).status).not.toBe(200);
    expect((await get('/voice/static/%2e%2e/state.json')).status).not.toBe(200);
    expect((await get('/voice/static/nope.js')).status).toBe(404);
  });
});

describe('sign in with Slack', () => {
  test('start sets a signed one-use nonce cookie and redirects to Slack with user scopes', async () => {
    const res = await get('/voice/oauth/start');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(location.searchParams.get('user_scope')).toContain('chat:write');
    expect(location.searchParams.get('user_scope')).toContain('groups:history');
    expect(location.searchParams.get('scope')).toBeNull();
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/callback`);
    expect(location.searchParams.get('state')).toBe('nonce-1');
    const cookie = setCookies(res).find((c) => c.startsWith(OAUTH_COOKIE)) as string;
    expect(cookie).toContain('Path=/voice;');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  test('callback with the matching nonce exchanges the code, stores the user, sets the session cookie', async () => {
    const start = await get('/voice/oauth/start');
    const nonceCookie = (setCookies(start)[0] as string).split(';')[0];

    const res = await get('/voice/oauth/callback?code=abc&state=nonce-1', { cookie: nonceCookie });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC_URL}/`);
    const exchange = slack.recorded.find((r) => r.method === 'oauth.v2.access') as { body: string };
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/callback`);
    expect(store.snapshot().users.U1).toEqual({ userId: 'U1', name: 'Almir', token: 'xoxp-1' });
    const session = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) as string;
    expect(session).toContain('Path=/voice;');
    expect(session).toContain('Max-Age=2592000');
    expect(setCookies(res).find((c) => c.startsWith(OAUTH_COOKIE))).toContain('Max-Age=0');
  });

  test('a missing, mismatched or forged nonce is refused and nothing is stored', async () => {
    expect((await get('/voice/oauth/callback?code=abc&state=nonce-1')).status).toBe(400);
    const start = await get('/voice/oauth/start');
    const nonceCookie = (setCookies(start)[0] as string).split(';')[0];
    expect((await get('/voice/oauth/callback?code=abc&state=other', { cookie: nonceCookie })).status).toBe(400);
    expect((await get('/voice/oauth/callback?code=abc&state=nonce-1', { cookie: `${OAUTH_COOKIE}=forged.value` })).status).toBe(400);

    expect(store.snapshot().users).toEqual({});
    expect(slack.recorded.find((r) => r.method === 'oauth.v2.access')).toBeUndefined();
  });

  test('a user from another workspace is refused', async () => {
    slack.script('oauth.v2.access', [{ ok: true, team: { id: 'T-OTHER' }, authed_user: { id: 'U9', access_token: 'xoxp-9' } }]);
    const start = await get('/voice/oauth/start');
    const nonceCookie = (setCookies(start)[0] as string).split(';')[0];

    const res = await get('/voice/oauth/callback?code=abc&state=nonce-1', { cookie: nonceCookie });

    expect(res.status).toBe(403);
    expect(store.snapshot().users).toEqual({});
  });

  test('a Slack error callback is a clean 400', async () => {
    expect((await get('/voice/oauth/callback?error=access_denied')).status).toBe(400);
  });
});

describe('gated routes', () => {
  test('every gated route answers 401 without a valid cookie and expires it', async () => {
    for (const path of ['/voice/me', '/voice/channels']) {
      const res = await get(path, { cookie: `${SESSION_COOKIE}=nonsense` });
      expect(res.status).toBe(401);
      expect(setCookies(res)[0]).toContain('Max-Age=0');
    }
    expect((await post('/voice/calls', { channel: 'C1' })).status).toBe(401);
  });

  test('a cookie for a user no longer in the store is 401', async () => {
    const cookie = `${SESSION_COOKIE}=${await createCookieSigner(SECRET).sign('U-GONE')}`;

    expect((await get('/voice/me', { cookie })).status).toBe(401);
  });

  test('/me and /channels work when signed in, and only task channels are offered', async () => {
    const cookie = await signedInCookie();

    expect(await (await get('/voice/me', { cookie })).json()).toEqual({ userId: 'U1', name: 'Almir' });
    expect(await (await get('/voice/channels', { cookie })).json()).toEqual({ channels: [{ id: 'C1', name: 'fix-backfill' }] });
  });

  test('mutations need our Origin and JSON', async () => {
    const cookie = await signedInCookie();

    expect((await post('/voice/calls', { channel: 'C1' }, { cookie, origin: 'https://evil.example' })).status).toBe(403);
    const noOrigin = await app.fetch(new Request(`${ORIGIN}/voice/calls`, { method: 'POST', body: '{}', headers: { cookie, 'content-type': 'application/json' } }));
    expect(noOrigin.status).toBe(403);
    const form = await app.fetch(new Request(`${ORIGIN}/voice/calls`, { method: 'POST', body: 'channel=C1', headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }));
    expect(form.status).toBe(415);
  });

  test('a call can only be started in an offered channel, and the response never carries secrets', async () => {
    const cookie = await signedInCookie();

    expect((await post('/voice/calls', { channel: 'C9' }, { cookie })).status).toBe(403);
    const res = await post('/voice/calls', { channel: 'C1' }, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json() as { callId: string; token: string; setup: { model: string } };
    expect(body.token).toBe('auth_tokens/tok');
    expect(body.setup.model).toBe('models/m');
    expect(JSON.stringify(body)).not.toContain('xoxp');
    expect(JSON.stringify(body)).not.toContain('csecret');
  });

  test('tool calls and end go through to the call, and a bad body is 400', async () => {
    const cookie = await signedInCookie();
    const { callId } = await (await post('/voice/calls', { channel: 'C1' }, { cookie })).json() as { callId: string };

    const tool = await post(`/voice/calls/${callId}/tool`, { id: 'g1', name: 'post_to_channel', args: { text: 'hello' } }, { cookie });
    expect(await tool.json()).toEqual({ ok: true, result: { posted: true }, scheduling: 'SILENT' });
    expect((await post(`/voice/calls/${callId}/tool`, { name: 'post_to_channel' }, { cookie })).status).toBe(400);
    expect((await post(`/voice/calls/${callId}/end`, {}, { cookie })).status).toBe(200);
    expect((await post(`/voice/calls/${callId}/end`, {}, { cookie })).status).toBe(404);
  });

  test('logout removes the token and expires the cookie', async () => {
    const cookie = await signedInCookie();

    const res = await post('/voice/logout', {}, { cookie });

    expect(res.status).toBe(200);
    expect(setCookies(res)[0]).toContain('Max-Age=0');
    expect(store.snapshot().users).toEqual({});
    expect((await get('/voice/me', { cookie })).status).toBe(401);
  });

  test('a dead Slack token on any call signs the user out with 401', async () => {
    const cookie = await signedInCookie();
    slack.script('conversations.list', [{ ok: false, error: 'invalid_auth' }]);

    const res = await get('/voice/channels', { cookie });

    expect(res.status).toBe(401);
    expect(store.snapshot().users).toEqual({});
  });
});
