/**
 * Unit tests for dynamic-channel mapping and config derivation.
 */

import { describe, it, expect } from 'bun:test';
import {
  channelPlatformId,
  resolveChannelWorkspace,
  deriveChannelPlatformConfig,
} from './channel-discovery.js';
import type { SlackPlatformConfig } from '../config/types.js';

const cfg = { reposDir: '/r', worktreesDir: '/w', scratchDir: '/s' };
const repos = ['vvs-handbook', 'vvs-trading-platform', 'vvs-data-research'];

describe('resolveChannelWorkspace', () => {
  it('maps repo-prefixed channel to a worktree with a slack/ branch', () => {
    const ws = resolveChannelWorkspace('vvs-trading-platform-fix-backfill', cfg, repos);
    expect(ws).toEqual({
      kind: 'repo',
      dir: '/w/vvs-trading-platform-fix-backfill',
      repoRoot: '/r/vvs-trading-platform',
      branch: 'slack/fix-backfill',
    });
  });

  it('prefers the LONGEST repo prefix', () => {
    const ws = resolveChannelWorkspace('vvs-trading-platform-x', cfg, ['vvs-trading', 'vvs-trading-platform']);
    expect(ws.repoRoot).toBe('/r/vvs-trading-platform');
    expect(ws.branch).toBe('slack/x');
  });

  it('channel named exactly like a repo uses the channel name as branch slug', () => {
    const ws = resolveChannelWorkspace('vvs-handbook', cfg, repos);
    expect(ws.branch).toBe('slack/vvs-handbook');
    expect(ws.repoRoot).toBe('/r/vvs-handbook');
  });

  it('does NOT match a repo name that is a substring but not a dash-prefix', () => {
    const ws = resolveChannelWorkspace('vvs-handbookish-thing', cfg, repos);
    expect(ws.kind).toBe('scratch');
  });

  it('rejects unsafe channel names', () => {
    expect(() => resolveChannelWorkspace('../etc', cfg, repos)).toThrow(/unsafe/);
    expect(() => resolveChannelWorkspace('a/..b', cfg, repos)).toThrow(/unsafe/);
    expect(() => resolveChannelWorkspace('.hidden', cfg, repos)).toThrow(/unsafe/);
  });

  it('no repo prefix → scratch dir', () => {
    const ws = resolveChannelWorkspace('random-idea', cfg, repos);
    expect(ws).toEqual({ kind: 'scratch', dir: '/s/random-idea' });
  });
});

describe('deriveChannelPlatformConfig', () => {
  const parent: SlackPlatformConfig = {
    id: 'slack-vvs',
    type: 'slack',
    displayName: 'VVS',
    botToken: 'xoxb-x',
    appToken: 'xapp-x',
    channelId: 'CPARENT',
    botName: 'claude',
    allowedUsers: [],
    dynamicChannels: { reposDir: '/r', worktreesDir: '/w', scratchDir: '/s' },
  };

  it('derives a DCM instance pinned to the channel and worktree', () => {
    const c = deriveChannelPlatformConfig(parent, 'CNEW', 'vvs-handbook-docs', '/w/vvs-handbook-docs');
    expect(c.id).toBe(channelPlatformId('slack-vvs', 'CNEW'));
    expect(c.channelId).toBe('CNEW');
    expect(c.workingDir).toBe('/w/vvs-handbook-docs');
    expect(c.directChannelMode).toBe(true);
    expect(c.stickyMessage).toBe('hidden');
    // must not re-discover channels itself
    expect(c.dynamicChannels).toBeUndefined();
    // inherits auth + tokens
    expect(c.botToken).toBe(parent.botToken);
    expect(c.appToken).toBe(parent.appToken);
  });
});
