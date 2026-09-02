import { describe, test, expect } from 'bun:test';
import { canUseChannel, taskChannels } from './channels.js';

function slackWith(script: Record<string, unknown[]>) {
  const fn = (async (url: string | URL | Request) => {
    const method = String(url).split('/').pop() as string;
    const next = script[method]?.shift();
    if (next === undefined) throw new Error(`no scripted answer for ${method}`);
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fn };
}

const LIST = {
  ok: true,
  channels: [
    { id: 'C1', name: 'fix-backfill', is_member: true },
    { id: 'C2', name: 'general', is_member: true },
    { id: 'C3', name: 'archived-task', is_member: true, is_archived: true },
    { id: 'C4', name: 'not-joined', is_member: false },
    { id: 'C5', name: 'shared-with-client', is_member: true, is_ext_shared: true },
  ],
  response_metadata: { next_cursor: '' },
};

const BINDINGS = JSON.stringify([
  { channelId: 'C1', channelName: 'fix-backfill', platformId: 'p', workspace: {} },
  { channelId: 'C3', channelName: 'archived-task', platformId: 'p', workspace: {} },
  { channelId: 'C4', channelName: 'not-joined', platformId: 'p', workspace: {} },
  { channelId: 'C5', channelName: 'shared-with-client', platformId: 'p', workspace: {} },
]);

describe('taskChannels', () => {
  test('offers only bound task channels the user is a member of, never archived or shared ones', async () => {
    const channels = await taskChannels(
      { slack: slackWith({ 'conversations.list': [LIST] }), botUserId: 'UBOT', bindingsFile: '/x/bindings.json', readFile: async () => BINDINGS },
      'xoxp',
    );

    expect(channels).toEqual([{ id: 'C1', name: 'fix-backfill' }]);
  });

  test('a channel the user is in but the daemon has not bound is not offered', async () => {
    const channels = await taskChannels(
      { slack: slackWith({ 'conversations.list': [LIST] }), botUserId: 'UBOT', bindingsFile: '/x/bindings.json', readFile: async () => BINDINGS },
      'xoxp',
    );

    expect(channels.find((c) => c.id === 'C2')).toBeUndefined();
  });

  test('a missing bindings file is an error, not an empty list', async () => {
    const missing = async () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; };

    await expect(taskChannels({ slack: slackWith({}), botUserId: 'UBOT', bindingsFile: '/nope.json', readFile: missing }, 'xoxp')).rejects.toThrow('ENOENT');
  });

  test('a malformed bindings file is an error, and so is a malformed entry', async () => {
    await expect(
      taskChannels({ slack: slackWith({}), bindingsFile: '/x.json', botUserId: 'UBOT', readFile: async () => '{"not":"an array"}' }, 'xoxp'),
    ).rejects.toThrow(/not an array/);
    await expect(
      taskChannels({ slack: slackWith({}), bindingsFile: '/x.json', botUserId: 'UBOT', readFile: async () => '[{"channelId":"C1"}]' }, 'xoxp'),
    ).rejects.toThrow(/malformed entry/);
  });
});

describe('canUseChannel', () => {
  test('is true only for an offered channel the bot is still in', async () => {
    const deps = {
      slack: slackWith({
        'conversations.list': [LIST, LIST, LIST],
        'conversations.members': [{ ok: true, members: ['U1', 'UBOT'], response_metadata: { next_cursor: '' } }, { ok: true, members: ['U1'], response_metadata: { next_cursor: '' } }],
      }),
      bindingsFile: '/x.json',
      botUserId: 'UBOT',
      readFile: async () => BINDINGS,
    };

    expect(await canUseChannel(deps, 'xoxp', 'C1')).toBe(true);   // bound, member, bot present
    expect(await canUseChannel(deps, 'xoxp', 'C1')).toBe(false);  // bot has left since
    expect(await canUseChannel(deps, 'xoxp', 'C2')).toBe(false);  // not bound
  });
});
