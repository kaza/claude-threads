import { describe, test, expect } from 'bun:test';
import { SlackError, callsAdd, isTokenDead, listChannels, oauthAccess, postMessage, history, userName } from './slack.js';

type Recorded = { url: string; init: RequestInit };

/** A Slack stand-in answering each method from a script, recording what was sent. */
function fakeSlack(script: Record<string, Array<{ status?: number; headers?: Record<string, string>; body: unknown }>>) {
  const calls: Recorded[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() as string;
    calls.push({ url: String(url), init: init ?? {} });
    const next = script[method]?.shift();
    if (!next) throw new Error(`no scripted answer for ${method}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json', ...(next.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('oauthAccess', () => {
  test('exchanges the code as a form post with the full redirect URI and returns the user token', async () => {
    const { fn, calls } = fakeSlack({ 'oauth.v2.access': [{ body: { ok: true, team: { id: 'T1' }, authed_user: { id: 'U1', access_token: 'xoxp-1' } } }] });

    const result = await oauthAccess({ fetch: fn }, { clientId: 'c', clientSecret: 's', code: 'code-1', redirectUri: 'https://agents.vvs-capital.com/voice/oauth/callback' });

    expect(result).toEqual({ teamId: 'T1', userId: 'U1', token: 'xoxp-1' });
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('redirect_uri')).toBe('https://agents.vvs-capital.com/voice/oauth/callback');
    expect(body.get('code')).toBe('code-1');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toContain('x-www-form-urlencoded');
  });

  test('an answer without a user token is an error', async () => {
    const { fn } = fakeSlack({ 'oauth.v2.access': [{ body: { ok: true, team: { id: 'T1' }, access_token: 'xoxb-bot-only' } }] });

    await expect(oauthAccess({ fetch: fn }, { clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' })).rejects.toThrow('missing_user_token');
  });
});

describe('argument encoding', () => {
  // Seen live 2026-09-02: users.info answered user_not_found because the user id
  // travelled in a JSON body, which Slack's read methods silently ignore.
  test('arguments are form-encoded, the one encoding every Slack method accepts', async () => {
    const { fn, calls } = fakeSlack({ 'users.info': [{ body: { ok: true, user: { real_name: 'Almir' } } }] });

    const name = await userName({ fetch: fn }, 'xoxp', 'U1');

    expect(name).toBe('Almir');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toContain('x-www-form-urlencoded');
    expect(new URLSearchParams(calls[0].init.body as string).get('user')).toBe('U1');
  });

  test('nested arguments (blocks) travel as JSON strings inside the form', async () => {
    const { fn, calls } = fakeSlack({ 'chat.postMessage': [{ body: { ok: true, ts: '1' } }] });

    await postMessage({ fetch: fn }, 'xoxp', 'C1', 'hi', 'R1');

    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('channel')).toBe('C1');
    expect(body.get('text')).toBe('hi');
    expect(JSON.parse(body.get('blocks') as string)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'hi' } },
      { type: 'call', call_id: 'R1' },
    ]);
  });
});

describe('Slack errors', () => {
  test('ok:false becomes a SlackError carrying the code', async () => {
    const { fn } = fakeSlack({ 'chat.postMessage': [{ body: { ok: false, error: 'not_in_channel' } }] });

    const attempt = postMessage({ fetch: fn }, 'xoxp', 'C1', 'hi');

    await expect(attempt).rejects.toMatchObject({ code: 'not_in_channel' });
  });

  test('a non-JSON answer (an HTML error page) is a SlackError with the status, not a parse crash', async () => {
    const fn = (async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

    await expect(postMessage({ fetch: fn }, 'xoxp', 'C1', 'hi')).rejects.toMatchObject({ code: 'http_502_not_json' });
  });

  test('every request carries a timeout signal', async () => {
    const { fn, calls } = fakeSlack({ 'chat.postMessage': [{ body: { ok: true, ts: '1' } }] });

    await postMessage({ fetch: fn }, 'xoxp', 'C1', 'hi');

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(calls[0].init.body as string).has('blocks')).toBe(false);
  });

  test('a 429 becomes a ratelimited error with Retry-After, without retrying', async () => {
    const { fn, calls } = fakeSlack({ 'conversations.history': [{ status: 429, headers: { 'retry-after': '7' }, body: {} }] });

    const attempt = history({ fetch: fn }, 'xoxp', 'C1', '0');

    await expect(attempt).rejects.toMatchObject({ code: 'ratelimited', retryAfterSeconds: 7 });
    expect(calls).toHaveLength(1);
  });

  test('dead-token codes are recognised', () => {
    expect(isTokenDead(new SlackError('x', 'invalid_auth'))).toBe(true);
    expect(isTokenDead(new SlackError('x', 'token_revoked'))).toBe(true);
    expect(isTokenDead(new SlackError('x', 'ratelimited'))).toBe(false);
    expect(isTokenDead(new Error('boom'))).toBe(false);
  });
});

describe('listChannels', () => {
  test('follows pagination and normalises the flags', async () => {
    const { fn } = fakeSlack({
      'conversations.list': [
        { body: { ok: true, channels: [{ id: 'C1', name: 'one', is_member: true }], response_metadata: { next_cursor: 'p2' } } },
        { body: { ok: true, channels: [{ id: 'C2', name: 'two', is_archived: true, is_ext_shared: true, is_private: true }], response_metadata: { next_cursor: '' } } },
      ],
    });

    const channels = await listChannels({ fetch: fn }, 'xoxp');

    expect(channels).toEqual([
      { id: 'C1', name: 'one', isMember: true, isArchived: false, isExtShared: false, isPrivate: false },
      { id: 'C2', name: 'two', isMember: false, isArchived: true, isExtShared: true, isPrivate: true },
    ]);
  });
});

describe('callsAdd', () => {
  test('registers the call with the join URL and creator and returns Slack\'s call id', async () => {
    const { fn, calls } = fakeSlack({ 'calls.add': [{ body: { ok: true, call: { id: 'R1' } } }] });

    const result = await callsAdd({ fetch: fn }, 'xoxp', { externalUniqueId: 'C1-1', joinUrl: 'https://x/voice/?channel=C1', title: 'Voice', userId: 'U1' });

    expect(result).toEqual({ id: 'R1' });
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('external_unique_id')).toBe('C1-1');
    expect(body.get('join_url')).toBe('https://x/voice/?channel=C1');
    expect(JSON.parse(body.get('users') as string)).toEqual([{ slack_id: 'U1' }]);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer xoxp');
  });
});
