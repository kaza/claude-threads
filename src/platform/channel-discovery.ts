/**
 * Dynamic channel discovery (Slack).
 *
 * With `dynamicChannels` on a Slack platform entry, @-mentioning the bot in
 * any channel it is a member of spawns a derived platform instance for that
 * channel: a clone of the parent entry pointed at the channel, running in
 * direct channel mode, working in a git worktree (or scratch dir) derived
 * from the channel name. See docs/dynamic-channels-spec.md.
 *
 * Unlike Mattermost DM discovery, derived Slack instances NEVER open their
 * own Socket Mode connection — Slack round-robins event envelopes across an
 * app's connections, so a second socket steals events from the first. The
 * parent client keeps the only socket and injects events into derived
 * clients (the parent is passed to the derived client's constructor).
 */

import * as path from 'node:path';
import type { SlackPlatformConfig } from '../config/types.js';

/** Separator between the parent platform id and the channel id. */
export const CH_PLATFORM_SEP = '--ch-';

/** Platform id for a derived channel instance. */
export function channelPlatformId(parentId: string, channelId: string): string {
  return `${parentId}${CH_PLATFORM_SEP}${channelId}`;
}

/** Workspace resolved for a channel name. */
export interface ChannelWorkspace {
  kind: 'repo' | 'scratch';
  /** Directory the session works in (worktree or scratch dir). */
  dir: string;
  /** Repo root the worktree belongs to (kind === 'repo' only). */
  repoRoot?: string;
  /** Branch backing the worktree (kind === 'repo' only). */
  branch?: string;
}

/**
 * Map a channel name onto a workspace.
 *
 * Longest prefix match of the channel name against `repoNames` picks the
 * repo; the remainder (sans leading '-') is the task slug and names the
 * branch `slack/<slug>`. No match → a plain scratch directory.
 */
/**
 * Slack constrains channel names to lowercase alphanumerics, '-', '_' and
 * '.' — but we build filesystem paths and branch names from them, so we
 * enforce it ourselves. Anything else (or path-traversal shapes) throws.
 */
export function sanitizeChannelName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(`Refusing unsafe channel name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function resolveChannelWorkspace(
  channelName: string,
  cfg: { reposDir: string; worktreesDir: string; scratchDir: string },
  repoNames: string[],
): ChannelWorkspace {
  channelName = sanitizeChannelName(channelName);
  const sorted = [...repoNames].sort((a, b) => b.length - a.length);
  const repo = sorted.find(
    (r) => channelName === r || channelName.startsWith(`${r}-`),
  );
  if (!repo) {
    return { kind: 'scratch', dir: path.join(cfg.scratchDir, channelName) };
  }
  const slug = channelName === repo ? '' : channelName.slice(repo.length + 1);
  return {
    kind: 'repo',
    dir: path.join(cfg.worktreesDir, channelName),
    repoRoot: path.join(cfg.reposDir, repo),
    branch: `slack/${slug || channelName}`,
  };
}

/**
 * Derive the platform config for a channel instance from its parent entry.
 *
 * DCM on (the channel *is* the conversation), sticky hidden (the channel is
 * about one task, not a session directory), and — crucially — the derived
 * instance shares the parent's event source instead of connecting itself.
 */
export function deriveChannelPlatformConfig(
  parent: SlackPlatformConfig,
  channelId: string,
  channelName: string,
  workingDir: string,
): SlackPlatformConfig {
  return {
    ...parent,
    id: channelPlatformId(parent.id, channelId),
    displayName: `#${channelName}`,
    channelId,
    workingDir,
    directChannelMode: parent.dynamicChannels?.directChannelMode ?? true,
    permissionMode: parent.dynamicChannels?.permissionMode ?? 'bypass',
    stickyMessage: 'hidden',
    sessionHeader: 'minimal',
    // The derived instance must not re-discover channels itself.
    dynamicChannels: undefined,
  };
}
