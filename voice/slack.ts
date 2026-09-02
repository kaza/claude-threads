/**
 * voice-desk: the few Slack Web API calls it needs, over fetch.
 * Every call takes the token explicitly; the client holds nothing.
 */

export interface SlackDeps {
  fetch: typeof fetch;
  apiUrl?: string;
  /** One line per API call: method, outcome, duration, Retry-After. Never message text. */
  log?: (line: string) => void;
}

const DEFAULT_API_URL = 'https://slack.com/api';
/** Slack answers in well under a second; a stalled connection must not hold a tool call open. */
const REQUEST_TIMEOUT_MS = 30_000;

async function parse<T>(response: Response, method: string): Promise<{ ok: boolean; error?: string } & T> {
  try {
    return (await response.json()) as { ok: boolean; error?: string } & T;
  } catch {
    throw new SlackError(method, `http_${response.status}_not_json`);
  }
}

/** A Slack `ok: false` answer, with the error code Slack gave. */
export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Slack ${method}: ${code}${retryAfterSeconds ? ` (retry after ${retryAfterSeconds}s)` : ''}`);
  }
}

/** Errors that mean the user's token is gone for good: sign in again. */
export const TOKEN_DEAD_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'token_expired', 'not_authed']);

export function isTokenDead(err: unknown): boolean {
  return err instanceof SlackError && TOKEN_DEAD_ERRORS.has(err.code);
}

async function call<T>(deps: SlackDeps, method: string, token: string | null, params: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = Date.now();
  const done = (outcome: string) => deps.log?.(`slack ${method} ${outcome} ${Date.now() - started}ms`);
  let response: Response;
  try {
    response = await deps.fetch(`${(deps.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    done(`transport-error ${(err as Error).name}`);
    throw err;
  }
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after') ?? '1');
    done(`429 retry-after=${retry}`);
    throw new SlackError(method, 'ratelimited', Number.isFinite(retry) ? retry : 1);
  }
  const data = await parse<T>(response, method).catch((err) => { done(`http_${response.status} not-json`); throw err; });
  if (!data.ok) {
    done(`error=${data.error ?? `http_${response.status}`}`);
    throw new SlackError(method, data.error ?? `http_${response.status}`);
  }
  done('ok');
  return data;
}

/** oauth.v2.access is form-encoded and unauthenticated. */
async function formCall<T>(deps: SlackDeps, method: string, params: Record<string, string>): Promise<T> {
  const response = await deps.fetch(`${(deps.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await parse<T>(response, method);
  if (!data.ok) throw new SlackError(method, data.error ?? `http_${response.status}`);
  return data;
}

// ---------------------------------------------------------------------------

export interface OAuthResult {
  teamId: string;
  userId: string;
  /** The user token (xoxp). */
  token: string;
}

export async function oauthAccess(
  deps: SlackDeps,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<OAuthResult> {
  const data = await formCall<{ team?: { id?: string }; authed_user?: { id?: string; access_token?: string } }>(deps, 'oauth.v2.access', {
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  const teamId = data.team?.id;
  const userId = data.authed_user?.id;
  const token = data.authed_user?.access_token;
  if (!teamId || !userId || !token) throw new SlackError('oauth.v2.access', 'missing_user_token');
  return { teamId, userId, token };
}

export async function userName(deps: SlackDeps, token: string, userId: string): Promise<string> {
  const data = await call<{ user?: { real_name?: string; name?: string } }>(deps, 'users.info', token, { user: userId });
  return data.user?.real_name || data.user?.name || userId;
}

export interface ChannelInfo {
  id: string;
  name: string;
  isMember: boolean;
  isArchived: boolean;
  isExtShared: boolean;
  isPrivate: boolean;
}

/** All channels the token can see, paginated. */
export async function listChannels(deps: SlackDeps, token: string): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = [];
  let cursor: string | undefined;
  do {
    const data = await call<{
      channels?: Array<{ id: string; name: string; is_member?: boolean; is_archived?: boolean; is_ext_shared?: boolean; is_private?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>(deps, 'conversations.list', token, { types: 'public_channel,private_channel', exclude_archived: false, limit: 200, cursor });
    for (const c of data.channels ?? []) {
      out.push({ id: c.id, name: c.name, isMember: !!c.is_member, isArchived: !!c.is_archived, isExtShared: !!c.is_ext_shared, isPrivate: !!c.is_private });
    }
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

export async function channelMembers(deps: SlackDeps, token: string, channel: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const data = await call<{ members?: string[]; response_metadata?: { next_cursor?: string } }>(deps, 'conversations.members', token, { channel, limit: 500, cursor });
    out.push(...(data.members ?? []));
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

export async function postMessage(deps: SlackDeps, token: string, channel: string, text: string): Promise<{ ts: string }> {
  const data = await call<{ ts?: string }>(deps, 'chat.postMessage', token, { channel, text });
  return { ts: data.ts ?? '' };
}

export interface HistoryEntry {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: Array<{ id: string }>;
}

/** Latest messages in a channel (one page is plenty for a 4 s poll). */
export async function history(deps: SlackDeps, token: string, channel: string, oldest: string): Promise<HistoryEntry[]> {
  const data = await call<{ messages?: HistoryEntry[] }>(deps, 'conversations.history', token, { channel, oldest, limit: 50, inclusive: false });
  return data.messages ?? [];
}

export async function callsAdd(
  deps: SlackDeps,
  token: string,
  args: { externalUniqueId: string; joinUrl: string; title: string; userId: string },
): Promise<{ id: string }> {
  const data = await call<{ call?: { id?: string } }>(deps, 'calls.add', token, {
    external_unique_id: args.externalUniqueId,
    join_url: args.joinUrl,
    title: args.title,
    created_by: args.userId,
    users: [{ slack_id: args.userId }],
  });
  if (!data.call?.id) throw new SlackError('calls.add', 'missing_call_id');
  return { id: data.call.id };
}

export async function postCallBlock(deps: SlackDeps, token: string, channel: string, slackCallId: string): Promise<{ ts: string }> {
  const data = await call<{ ts?: string }>(deps, 'chat.postMessage', token, {
    channel,
    text: 'Voice call with the agent',
    blocks: [{ type: 'call', call_id: slackCallId }],
  });
  return { ts: data.ts ?? '' };
}

export async function callParticipantsAdd(deps: SlackDeps, token: string, slackCallId: string, userId: string): Promise<void> {
  await call(deps, 'calls.participants.add', token, { id: slackCallId, users: [{ slack_id: userId }] });
}

export async function callParticipantsRemove(deps: SlackDeps, token: string, slackCallId: string, userId: string): Promise<void> {
  await call(deps, 'calls.participants.remove', token, { id: slackCallId, users: [{ slack_id: userId }] });
}

export async function callsEnd(deps: SlackDeps, token: string, slackCallId: string): Promise<void> {
  await call(deps, 'calls.end', token, { id: slackCallId });
}
