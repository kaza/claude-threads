/**
 * voice-desk: the HTTP surface. See docs/voice-desk-spec.md § Routes and
 * § Sign in with Slack. `createApp` returns a fetch handler so the whole
 * thing is testable without a socket.
 */

import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { Calls, HttpError } from './calls.js';
import { taskChannels, canUseChannel, type ChannelDeps } from './channels.js';
import { createCookieSigner, parseCookies, randomToken, serializeCookie, type Store, type StoredUser } from './session.js';
import { SlackError, isTokenDead, oauthAccess, userName, type SlackDeps } from './slack.js';

export interface AppDeps {
  /** External prefix under which the app is reachable ('' or '/voice'). */
  basePath: string;
  /** Absolute public URL including the prefix, no trailing slash. */
  publicUrl: string;
  slack: SlackDeps;
  slackClientId: string;
  slackClientSecret: string;
  slackTeamId: string;
  store: Store;
  sessionSecret: string;
  calls: Calls;
  channels: ChannelDeps;
  publicDir: string;
  log: (line: string) => void;
  randomToken?: () => string;
}

export const SESSION_COOKIE = '__Secure-voice';
export const OAUTH_COOKIE = '__Secure-voice-oauth';
const SESSION_MAX_AGE = 30 * 24 * 3600;
const OAUTH_MAX_AGE = 600;
const USER_SCOPES = 'chat:write channels:read channels:history groups:read groups:history calls:write users:read';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://generativelanguage.googleapis.com; img-src 'self' data:; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

function withHeaders(response: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...securityHeaders(), ...extra })) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withHeaders(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }), extra);
}

function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return withHeaders(new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), extra);
}

export function createApp(deps: AppDeps): { fetch: (req: Request) => Promise<Response> } {
  const signer = createCookieSigner(deps.sessionSecret);
  /** OAuth nonces issued and not yet consumed, with their expiry: a callback may use one exactly once. */
  const pendingNonces = new Map<string, number>();
  const takeNonce = (nonce: string): boolean => {
    const expires = pendingNonces.get(nonce);
    pendingNonces.delete(nonce);
    for (const [n, t] of pendingNonces) if (t < Date.now()) pendingNonces.delete(n);
    return expires !== undefined && expires >= Date.now();
  };
  const origin = new URL(deps.publicUrl).origin;
  const cookiePath = deps.basePath === '' ? '' : deps.basePath;
  const nonce = deps.randomToken ?? randomToken;

  const sessionCookie = (value: string, maxAge = SESSION_MAX_AGE) => serializeCookie(SESSION_COOKIE, value, { path: cookiePath, maxAgeSeconds: maxAge });
  const oauthCookie = (value: string, maxAge = OAUTH_MAX_AGE) => serializeCookie(OAUTH_COOKIE, value, { path: cookiePath, maxAgeSeconds: maxAge });
  const expired = () => sessionCookie('', 0);

  function stripBase(pathname: string): string | null {
    if (deps.basePath === '') return pathname;
    if (pathname === deps.basePath) return '';
    if (pathname.startsWith(`${deps.basePath}/`)) return pathname.slice(deps.basePath.length);
    // Behind Caddy handle_path the prefix is already gone.
    return pathname;
  }

  /** The cookie carries `userId:session`; both must match the stored user. */
  async function currentUser(req: Request): Promise<StoredUser | null> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const value = await signer.verify(cookies[SESSION_COOKIE]);
    if (!value) return null;
    const colon = value.indexOf(':');
    if (colon <= 0) return null;
    const user = deps.store.snapshot().users[value.slice(0, colon)];
    if (!user || !user.session || user.session !== value.slice(colon + 1)) return null;
    return user;
  }

  /** CSRF: browsers send Origin on every cross-site and same-site POST; require ours, and JSON. */
  function guardMutation(req: Request): Response | null {
    if (req.headers.get('origin') !== origin) return json({ error: 'forbidden origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'json only' }, 415);
    return null;
  }

  async function readJson(req: Request): Promise<Record<string, unknown>> {
    try {
      const body = (await req.json()) as unknown;
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, 'invalid json');
    }
  }

  async function serveStatic(relative: string): Promise<Response> {
    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
    const path = join(deps.publicDir, safe);
    if (!path.startsWith(deps.publicDir)) return text('not found', 404);
    try {
      const body = await readFile(path);
      return withHeaders(new Response(body, { headers: { 'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' } }));
    } catch {
      return text('not found', 404);
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = stripBase(url.pathname);
    if (path === null) return text('not found', 404);

    // --- public ------------------------------------------------------------
    if (req.method === 'GET' && path === '') return withHeaders(Response.redirect(`${deps.publicUrl}/`, 302));
    if (req.method === 'GET' && path === '/') return serveStatic('index.html');
    if (req.method === 'GET' && path.startsWith('/static/')) return serveStatic(path.slice('/static/'.length));

    if (req.method === 'GET' && path === '/oauth/start') {
      const state = nonce();
      pendingNonces.set(state, Date.now() + OAUTH_MAX_AGE * 1000);
      const signedState = await signer.sign(state);
      const authorize = new URL('https://slack.com/oauth/v2/authorize');
      authorize.searchParams.set('client_id', deps.slackClientId);
      authorize.searchParams.set('user_scope', USER_SCOPES);
      authorize.searchParams.set('redirect_uri', `${deps.publicUrl}/oauth/callback`);
      authorize.searchParams.set('state', state);
      return withHeaders(Response.redirect(authorize.toString(), 302), { 'Set-Cookie': oauthCookie(signedState) });
    }

    if (req.method === 'GET' && path === '/oauth/callback') {
      const clear = oauthCookie('', 0);
      if (url.searchParams.get('error')) return text(`Slack sign-in was not completed: ${url.searchParams.get('error')}`, 400, { 'Set-Cookie': clear });
      const cookies = parseCookies(req.headers.get('cookie'));
      const expectedState = await signer.verify(cookies[OAUTH_COOKIE]);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!expectedState || !state || state !== expectedState || !code || !takeNonce(state)) {
        return text('sign-in state mismatch or already used; start again', 400, { 'Set-Cookie': clear });
      }
      const access = await oauthAccess(deps.slack, {
        clientId: deps.slackClientId,
        clientSecret: deps.slackClientSecret,
        code,
        redirectUri: `${deps.publicUrl}/oauth/callback`,
      });
      if (access.teamId !== deps.slackTeamId) return text('this Slack workspace is not allowed here', 403, { 'Set-Cookie': clear });
      const name = await userName(deps.slack, access.token, access.userId);
      const session = nonce();
      await deps.store.update((s) => { s.users[access.userId] = { userId: access.userId, name, token: access.token, session }; });
      deps.log(`user=${access.userId} signed in`);
      const headers = new Headers({ Location: `${deps.publicUrl}/` });
      headers.append('Set-Cookie', sessionCookie(await signer.sign(`${access.userId}:${session}`)));
      headers.append('Set-Cookie', clear);
      return withHeaders(new Response(null, { status: 302, headers }));
    }

    // --- signed in ---------------------------------------------------------
    const user = await currentUser(req);
    if (!user) return json({ error: 'sign in' }, 401, { 'Set-Cookie': expired() });

    if (req.method === 'GET' && path === '/me') return json({ userId: user.userId, name: user.name });
    if (req.method === 'GET' && path === '/channels') return json({ channels: await taskChannels(deps.channels, user.token) });

    if (req.method !== 'POST') return text('not found', 404);
    const blocked = guardMutation(req);
    if (blocked) return blocked;

    if (path === '/logout') {
      // Their live calls end first (cards, pollers, mailboxes), then the token goes.
      await deps.calls.endAllForUser(user);
      await deps.store.update((s) => { delete s.users[user.userId]; });
      deps.log(`user=${user.userId} signed out`);
      return json({ ok: true }, 200, { 'Set-Cookie': expired() });
    }

    if (path === '/calls') {
      const body = await readJson(req);
      const channel = typeof body.channel === 'string' ? body.channel : '';
      if (!channel || !(await canUseChannel(deps.channels, user.token, channel))) throw new HttpError(403, 'not a task channel you can use');
      return json(await deps.calls.create(user, channel));
    }

    const m = /^\/calls\/([A-Za-z0-9_-]+)\/(token|tool|end)$/.exec(path);
    if (m) {
      const [, callId, action] = m;
      const body = await readJson(req);
      if (action === 'token') {
        const resume = typeof body.resume === 'string' && body.resume ? body.resume : undefined;
        return json(await deps.calls.token(user, callId, resume));
      }
      if (action === 'tool') {
        const id = typeof body.id === 'string' ? body.id : '';
        const name = typeof body.name === 'string' ? body.name : '';
        const args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
        if (!id || !name) throw new HttpError(400, 'tool needs id and name');
        return json(await deps.calls.tool(user, callId, { id, name, args }));
      }
      await deps.calls.end(user, callId);
      return json({ ok: true });
    }

    return text('not found', 404);
  }

  return {
    async fetch(req) {
      try {
        return await handle(req);
      } catch (err) {
        if (err instanceof HttpError) {
          return json({ error: err.message }, err.status, err.status === 401 ? { 'Set-Cookie': expired() } : {});
        }
        if (isTokenDead(err)) {
          const user = await currentUser(req);
          if (user) await deps.store.update((s) => { delete s.users[user.userId]; });
          return json({ error: 'Slack token no longer valid; sign in again' }, 401, { 'Set-Cookie': expired() });
        }
        if (err instanceof SlackError) {
          deps.log(`slack error: ${err.message}`);
          return json({ error: err.message }, 502);
        }
        deps.log(`unhandled: ${(err as Error).stack ?? String(err)}`);
        return json({ error: 'internal error' }, 500);
      }
    },
  };
}
