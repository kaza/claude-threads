/**
 * voice-desk: which channels a person may talk to the agent in.
 * See docs/voice-desk-spec.md § Routes (GET /channels) and review findings
 * 8–10: task channels only (the daemon's dynamic-channel bindings are the
 * source of truth — thread-mode channels answer inside threads, which channel
 * history never shows, so there is no safe fallback), user a member, nothing
 * archived or shared outside the workspace.
 */

import { readFile } from 'fs/promises';
import { channelMembers, listChannels, type SlackDeps } from './slack.js';

export interface TaskChannel {
  id: string;
  name: string;
}

/** One entry of the daemon's `dynamic-channels-<platformId>.json`. */
interface Binding {
  channelId: string;
  channelName: string;
}

export interface ChannelDeps {
  slack: SlackDeps;
  /** The daemon's binding file. Required. */
  bindingsFile: string;
  /** The Claude Code bot's user id; a bound channel it has since left is not usable. */
  botUserId: string;
  readFile?: (path: string) => Promise<string>;
}

async function bindings(deps: ChannelDeps): Promise<Binding[]> {
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const parsed = JSON.parse(await read(deps.bindingsFile)) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`bindings file is not an array: ${deps.bindingsFile}`);
  for (const b of parsed) {
    if (typeof b?.channelId !== 'string' || typeof b?.channelName !== 'string') {
      throw new Error(`bindings file has a malformed entry: ${JSON.stringify(b).slice(0, 120)}`);
    }
  }
  return parsed as Binding[];
}

/**
 * Task channels the signed-in user may use: bound dynamic channels the user
 * is a member of. Archived and externally shared channels are never offered.
 * A missing or malformed bindings file is an error, never an empty list that
 * looks like "no channels".
 */
export async function taskChannels(deps: ChannelDeps, userToken: string): Promise<TaskChannel[]> {
  const bound = new Map((await bindings(deps)).map((b) => [b.channelId, b.channelName]));
  const visible = await listChannels(deps.slack, userToken);
  return visible
    .filter((c) => bound.has(c.id) && c.isMember && !c.isArchived && !c.isExtShared)
    .map((c) => ({ id: c.id, name: bound.get(c.id) ?? c.name }));
}

/**
 * True when the user may start a call in this channel right now: offered by
 * `taskChannels`, and the bot is still a member (a stale binding after the
 * bot was removed must not be usable — review finding 9).
 */
export async function canUseChannel(deps: ChannelDeps, userToken: string, channelId: string): Promise<boolean> {
  if (!(await taskChannels(deps, userToken)).some((c) => c.id === channelId)) return false;
  const members = await channelMembers(deps.slack, userToken, channelId);
  return members.includes(deps.botUserId);
}
