/**
 * voice-desk: the call lifecycle end to end against fake Slack and Gemini.
 * See docs/voice-desk-spec.md tests 5–9.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Calls, HttpError } from './calls.js';
import { QUIET_POLLS } from './poller.js';
import { createStore, type Store, type StoredUser } from './session.js';

const BOT = 'UBOT';
const ALICE: StoredUser = { userId: 'U1', name: 'Alice', token: 'xoxp-alice' };
const BOB: StoredUser = { userId: 'U2', name: 'Bob', token: 'xoxp-bob' };

type Recorded = { method: string; auth: string | undefined; body: Record<string, unknown> };

/** Fake Slack + Gemini behind one fetch. Answers come from per-method queues, else sensible defaults. */
function fakeApis() {
  const recorded: Recorded[] = [];
  const queues: Record<string, Array<{ status?: number; headers?: Record<string, string>; body: unknown }>> = {};
  let historyMessages: unknown[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = u.split('/').pop() as string;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    recorded.push({ method, auth: headers.Authorization, body });
    const scripted = queues[method]?.shift();
    if (scripted) {
      return new Response(JSON.stringify(scripted.body), { status: scripted.status ?? 200, headers: { 'content-type': 'application/json', ...(scripted.headers ?? {}) } });
    }
    const defaults: Record<string, unknown> = {
      'auth_tokens': { name: 'auth_tokens/tok', expireTime: '2026-09-02T10:30:00Z' },
      'calls.add': { ok: true, call: { id: 'R1' } },
      'chat.postMessage': { ok: true, ts: '1.500000' },
      'calls.participants.add': { ok: true },
      'calls.participants.remove': { ok: true },
      'calls.end': { ok: true },
      'conversations.history': { ok: true, messages: historyMessages },
    };
    return new Response(JSON.stringify(defaults[method] ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    fetch: fn,
    recorded,
    script(method: string, answers: Array<{ status?: number; headers?: Record<string, string>; body: unknown }>) { queues[method] = answers; },
    setHistory(messages: unknown[]) { historyMessages = messages; },
    calls(method: string) { return recorded.filter((r) => r.method === method); },
  };
}

let dir: string;
let store: Store;
let apis: ReturnType<typeof fakeApis>;
let clock: number;
let calls: Calls;
let logs: string[];

async function makeCalls(overrides: Partial<ConstructorParameters<typeof Calls>[0]> = {}) {
  return new Calls({
    store,
    slack: { fetch: apis.fetch },
    gemini: { apiKey: 'g', fetch: apis.fetch, now: () => new Date(clock) },
    botUserId: BOT,
    publicUrl: 'https://agents.vvs-capital.com/voice',
    model: 'gemini-test',
    voiceName: 'Aoede',
    now: () => clock,
    log: (l) => logs.push(l),
    waitDeadlineMs: 30,
    pollIntervalMs: 100_000, // tests drive pollOnce() by hand
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-calls-'));
  store = await createStore(join(dir, 'state.json'));
  await store.update((s) => { s.users[ALICE.userId] = ALICE; s.users[BOB.userId] = BOB; });
  apis = fakeApis();
  clock = 1_700_000_000_000;
  logs = [];
  calls = await makeCalls();
});

afterEach(async () => {
  calls.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('creating a call', () => {
  test('mints a locked token, records the call for its owner, and posts the call card once', async () => {
    const created = await calls.create(ALICE, 'C1');

    expect(created.token).toBe('auth_tokens/tok');
    expect((created.setup as { model: string }).model).toBe('models/gemini-test');
    expect((created.setup as { tools: unknown[] }).tools).toHaveLength(1);
    const stored = store.snapshot().calls[created.callId];
    expect(stored.userId).toBe('U1');
    expect(stored.channel).toBe('C1');
    expect(apis.calls('calls.add')).toHaveLength(1);
    expect(apis.calls('calls.add')[0].body.join_url).toBe('https://agents.vvs-capital.com/voice/?channel=C1');
    const block = apis.calls('chat.postMessage').find((c) => Array.isArray(c.body.blocks));
    expect(block?.body.blocks).toEqual([{ type: 'call', call_id: 'R1' }]);
    expect(JSON.stringify(created)).not.toContain('"g"');
  });

  test('two first calls at the same instant create one card, not two', async () => {
    await Promise.all([calls.create(ALICE, 'C1'), calls.create(BOB, 'C1')]);

    expect(apis.calls('calls.add')).toHaveLength(1);
    expect(apis.calls('calls.participants.add')).toHaveLength(1);
  });

  test('a person\'s second tab is not a second participant, and leaving one tab keeps them on the card', async () => {
    const first = await calls.create(ALICE, 'C1');
    const second = await calls.create(ALICE, 'C1');
    expect(apis.calls('calls.participants.add')).toHaveLength(0);

    await calls.end(ALICE, first.callId);
    expect(apis.calls('calls.participants.remove')).toHaveLength(0);
    expect(apis.calls('calls.end')).toHaveLength(0);

    await calls.end(ALICE, second.callId);
    expect(apis.calls('calls.end')).toHaveLength(1);
  });

  test('a second person in the same channel joins the existing card instead of creating one', async () => {
    await calls.create(ALICE, 'C1');
    await calls.create(BOB, 'C1');

    expect(apis.calls('calls.add')).toHaveLength(1);
    expect(apis.calls('calls.participants.add')).toHaveLength(1);
    expect(apis.calls('calls.participants.add')[0].auth).toBe('Bearer xoxp-bob');
  });

  test('when posting the card block fails, the Slack call is ended again and nothing is stored', async () => {
    apis.script('chat.postMessage', [{ body: { ok: false, error: 'not_in_channel' } }]);

    await expect(calls.create(ALICE, 'C1')).rejects.toThrow('not_in_channel');

    expect(apis.calls('calls.end')).toHaveLength(1);
    expect(store.snapshot().cards).toEqual({});
    expect(store.snapshot().calls).toEqual({});
  });

  test('a Gemini failure while minting leaves no card, no call and no Slack side effect', async () => {
    apis.script('auth_tokens', [{ status: 500, body: { error: 'boom' } }]);

    await expect(calls.create(ALICE, 'C1')).rejects.toThrow(/Gemini auth_tokens HTTP 500/);

    expect(apis.calls('calls.add')).toHaveLength(0);
    expect(store.snapshot().calls).toEqual({});
    expect(store.snapshot().cards).toEqual({});
  });

  test('a reconnect token passes the resumption handle through and mints again', async () => {
    const created = await calls.create(ALICE, 'C1');

    await calls.token(ALICE, created.callId, 'handle-9');

    const mints = apis.calls('auth_tokens');
    expect(mints).toHaveLength(2);
    expect((mints[1].body.bidiGenerateContentSetup as { sessionResumption: unknown }).sessionResumption).toEqual({ handle: 'handle-9' });
  });

  test('another user cannot touch the call', async () => {
    const created = await calls.create(ALICE, 'C1');

    await expect(calls.token(BOB, created.callId)).rejects.toThrow(HttpError);
    await expect(calls.tool(BOB, created.callId, { id: 'x', name: 'wait_for_reply', args: {} })).rejects.toMatchObject({ status: 404 });
  });
});

describe('post_to_channel', () => {
  test('posts as the owner to the call\'s channel with the bot mention, ignoring any channel in the args', async () => {
    const created = await calls.create(ALICE, 'C1');

    const result = await calls.tool(ALICE, created.callId, { id: 'g1', name: 'post_to_channel', args: { text: 'rerun the backfill', channel: 'C-EVIL' } });

    expect(result).toEqual({ ok: true, result: { posted: true }, scheduling: 'SILENT' });
    const post = apis.calls('chat.postMessage').find((c) => !Array.isArray(c.body.blocks));
    expect(post?.auth).toBe('Bearer xoxp-alice');
    expect(post?.body.channel).toBe('C1');
    expect(post?.body.text).toBe('<@UBOT> rerun the backfill');
  });

  test('the same Gemini call id twice posts once and returns the first result', async () => {
    const created = await calls.create(ALICE, 'C1');

    await calls.tool(ALICE, created.callId, { id: 'g1', name: 'post_to_channel', args: { text: 'once' } });
    await calls.tool(ALICE, created.callId, { id: 'g1', name: 'post_to_channel', args: { text: 'once' } });

    expect(apis.calls('chat.postMessage').filter((c) => !Array.isArray(c.body.blocks))).toHaveLength(1);
  });

  test('a Slack failure is returned to the model as an interrupting error, without retrying', async () => {
    const created = await calls.create(ALICE, 'C1');
    apis.script('chat.postMessage', [{ status: 429, headers: { 'retry-after': '5' }, body: {} }]);

    const result = await calls.tool(ALICE, created.callId, { id: 'g2', name: 'post_to_channel', args: { text: 'hi' } });

    expect(result).toMatchObject({ ok: false, scheduling: 'INTERRUPT' });
    expect((result as { error: string }).error).toContain('ratelimited');
  });

  test('empty or over-long text is refused before reaching Slack', async () => {
    const created = await calls.create(ALICE, 'C1');

    await expect(calls.tool(ALICE, created.callId, { id: 'g3', name: 'post_to_channel', args: {} })).rejects.toMatchObject({ status: 400 });
    await expect(calls.tool(ALICE, created.callId, { id: 'g4', name: 'post_to_channel', args: { text: 'x'.repeat(2001) } })).rejects.toMatchObject({ status: 400 });
  });

  test('the 21st post within a minute is refused locally, across all of a person\'s calls', async () => {
    const created = await calls.create(ALICE, 'C1');
    const second = await calls.create(ALICE, 'C2');
    for (let i = 0; i < 20; i++) {
      await calls.tool(ALICE, created.callId, { id: `p${i}`, name: 'post_to_channel', args: { text: `msg ${i}` } });
    }

    await expect(calls.tool(ALICE, second.callId, { id: 'p20', name: 'post_to_channel', args: { text: 'one too many' } })).rejects.toMatchObject({ status: 429 });
    await expect(calls.tool(BOB, (await calls.create(BOB, 'C1')).callId, { id: 'b', name: 'post_to_channel', args: { text: 'bob is fine' } })).resolves.toMatchObject({ ok: true });
  });

  test('two concurrent deliveries of the same Gemini id post once and share the result', async () => {
    const created = await calls.create(ALICE, 'C1');

    const [a, b] = await Promise.all([
      calls.tool(ALICE, created.callId, { id: 'dup', name: 'post_to_channel', args: { text: 'once' } }),
      calls.tool(ALICE, created.callId, { id: 'dup', name: 'post_to_channel', args: { text: 'once' } }),
    ]);

    expect(a).toEqual(b);
    expect(apis.calls('chat.postMessage').filter((c) => !Array.isArray(c.body.blocks))).toHaveLength(1);
  });

  test('a dead token signs the user out: 401 and the callback fires', async () => {
    const dead: string[] = [];
    calls.stop();
    calls = await makeCalls({ onTokenDead: (u) => dead.push(u) });
    const created = await calls.create(ALICE, 'C1');
    apis.script('chat.postMessage', [{ body: { ok: false, error: 'token_revoked' } }]);

    await expect(calls.tool(ALICE, created.callId, { id: 'g5', name: 'post_to_channel', args: { text: 'hi' } })).rejects.toMatchObject({ status: 401 });
    expect(dead).toEqual(['U1']);
  });
});

describe('wait_for_reply and the poller', () => {
  const quiet = (text: string) => Array(QUIET_POLLS).fill([{ ts: '1700000001.000000', user: BOT, text }]);

  test('answers waiting (with willContinue) when nothing has settled by the deadline', async () => {
    const created = await calls.create(ALICE, 'C1');

    const result = await calls.tool(ALICE, created.callId, { id: 'w1', name: 'wait_for_reply', args: {} });

    expect(result).toEqual({ ok: true, result: { waiting: true }, scheduling: 'SILENT', willContinue: true });
  });

  test('delivers a settled agent reply with INTERRUPT scheduling, once', async () => {
    const created = await calls.create(ALICE, 'C1');
    for (const history of quiet('Backfill is green.')) {
      apis.setHistory(history);
      await calls.pollOnce('C1');
    }

    const first = await calls.tool(ALICE, created.callId, { id: 'w2', name: 'wait_for_reply', args: {} });
    const second = await calls.tool(ALICE, created.callId, { id: 'w3', name: 'wait_for_reply', args: {} });

    expect(first).toEqual({ ok: true, result: { replies: [{ ts: '1700000001.000000', text: 'Backfill is green.', updated: false }] }, scheduling: 'INTERRUPT', willContinue: false });
    expect((second as { result: unknown }).result).toEqual({ waiting: true });
  });

  test('a reply landing during the wait wakes the waiter', async () => {
    calls.stop();
    calls = await makeCalls({ waitDeadlineMs: 5_000 });
    const created = await calls.create(ALICE, 'C1');
    const pending = calls.tool(ALICE, created.callId, { id: 'w4', name: 'wait_for_reply', args: {} });
    for (const history of quiet('Done.')) {
      apis.setHistory(history);
      await calls.pollOnce('C1');
    }

    const result = await pending;

    expect((result as unknown as { result: { replies: unknown[] } }).result.replies).toHaveLength(1);
  });

  test('polls with a participant\'s token, and only messages after the call started reach a late joiner', async () => {
    const created = await calls.create(ALICE, 'C1');
    for (const history of quiet('Old news.')) {
      apis.setHistory(history);
      await calls.pollOnce('C1');
    }
    clock += 10_000;
    const late = await calls.create(BOB, 'C1');

    const alice = await calls.tool(ALICE, created.callId, { id: 'a', name: 'wait_for_reply', args: {} });
    const bob = await calls.tool(BOB, late.callId, { id: 'b', name: 'wait_for_reply', args: {} });

    expect((alice as unknown as { result: { replies: unknown[] } }).result.replies).toHaveLength(1);
    expect((bob as { result: unknown }).result).toEqual({ waiting: true });
    expect(apis.calls('conversations.history')[0].auth).toBe('Bearer xoxp-alice');
  });

  test('a human post between polls does not lose a reply', async () => {
    const created = await calls.create(ALICE, 'C1');
    const [h1, h2, h3] = quiet('Reply.');
    apis.setHistory(h1); await calls.pollOnce('C1');
    await calls.tool(ALICE, created.callId, { id: 'p', name: 'post_to_channel', args: { text: 'and also this' } });
    apis.setHistory(h2); await calls.pollOnce('C1');
    apis.setHistory(h3); await calls.pollOnce('C1');

    const result = await calls.tool(ALICE, created.callId, { id: 'w', name: 'wait_for_reply', args: {} });

    expect((result as unknown as { result: { replies: unknown[] } }).result.replies).toHaveLength(1);
  });

  test('the poll cursor moves past delivered posts older than ten minutes, and not before', async () => {
    await calls.create(ALICE, 'C1');
    clock += 60_000;
    const ts = (clock / 1000).toFixed(6); // a reply a minute into the call
    for (const history of Array(QUIET_POLLS).fill([{ ts, user: BOT, text: 'Done.' }])) {
      apis.setHistory(history);
      await calls.pollOnce('C1');
    }
    const before = apis.calls('conversations.history').at(-1)?.body.oldest;
    clock += 11 * 60 * 1000;
    await calls.pollOnce('C1');
    await calls.pollOnce('C1');

    const after = apis.calls('conversations.history').at(-1)?.body.oldest;

    expect(parseFloat(String(before))).toBeLessThan(parseFloat(ts));
    expect(after).toBe(ts);
  });

  test('a 429 from history pauses every poller until Retry-After', async () => {
    await calls.create(ALICE, 'C1');
    await calls.create(BOB, 'C2');
    apis.script('conversations.history', [{ status: 429, headers: { 'retry-after': '30' }, body: {} }]);

    await calls.pollOnce('C1');
    await calls.pollOnce('C2');

    expect(apis.calls('conversations.history')).toHaveLength(1);
    expect(logs.some((l) => l.includes('paused for 30s'))).toBe(true);
    clock += 31_000;
    await calls.pollOnce('C2');
    expect(apis.calls('conversations.history')).toHaveLength(2);
  });
});

describe('ending calls', () => {
  test('end_call removes the participant and, for the last leg, ends the card', async () => {
    const a = await calls.create(ALICE, 'C1');
    const b = await calls.create(BOB, 'C1');

    await calls.tool(ALICE, a.callId, { id: 'e1', name: 'end_call', args: {} });
    expect(apis.calls('calls.participants.remove')).toHaveLength(1);
    expect(apis.calls('calls.end')).toHaveLength(0);

    await calls.end(BOB, b.callId);
    expect(apis.calls('calls.end')).toHaveLength(1);
    expect(store.snapshot().cards).toEqual({});
    expect(store.snapshot().calls).toEqual({});
  });

  test('ending twice is harmless', async () => {
    const a = await calls.create(ALICE, 'C1');
    await calls.end(ALICE, a.callId);

    await expect(calls.end(ALICE, a.callId)).rejects.toMatchObject({ status: 404 });
    expect(apis.calls('calls.end')).toHaveLength(1);
  });

  test('boot cleanup ends every persisted card and forgets every call', async () => {
    await calls.create(ALICE, 'C1');
    calls.stop();
    apis.recorded.length = 0;
    const fresh = await makeCalls();

    await fresh.bootCleanup();

    expect(apis.calls('calls.end')).toHaveLength(1);
    expect(apis.calls('calls.end')[0].body.id).toBe('R1');
    expect(store.snapshot().calls).toEqual({});
    expect(store.snapshot().cards).toEqual({});
    fresh.stop();
  });

  test('boot cleanup keeps a card whose end failed, for the next try', async () => {
    await calls.create(ALICE, 'C1');
    calls.stop();
    apis.recorded.length = 0;
    apis.script('calls.end', [{ status: 200, body: { ok: false, error: 'internal_error' } }]);
    const fresh = await makeCalls();

    await fresh.bootCleanup();

    expect(store.snapshot().calls).toEqual({});
    expect(Object.keys(store.snapshot().cards)).toEqual(['C1']);
    fresh.stop();
  });

  test('endAllForUser ends every call of one person and nobody else\'s', async () => {
    await calls.create(ALICE, 'C1');
    await calls.create(ALICE, 'C2');
    const bob = await calls.create(BOB, 'C1');

    await calls.endAllForUser(ALICE);

    expect(Object.values(store.snapshot().calls).map((c) => c.callId)).toEqual([bob.callId]);
  });

  test('the reaper ends a call idle for 30 minutes', async () => {
    const a = await calls.create(ALICE, 'C1');
    clock += 31 * 60 * 1000;

    await calls.reap();

    expect(store.snapshot().calls[a.callId]).toBeUndefined();
    expect(apis.calls('calls.end')).toHaveLength(1);
  });
});
