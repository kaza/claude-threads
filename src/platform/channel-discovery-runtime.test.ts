/**
 * Unit tests for the dynamic-channel discovery runtime: cold spawn, dedupe,
 * teardown backstop verdicts, bindings persistence and boot reconstruction.
 */

import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChannelDiscoveryRuntime, type ChannelDiscoveryDeps } from './channel-discovery-runtime.js';
import type { SlackPlatformConfig } from '../config/types.js';
import type { PlatformClient, PlatformPost } from './index.js';

const parentConfig: SlackPlatformConfig = {
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

function makePost(channelId: string): PlatformPost {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    platformId: 'slack-vvs',
    channelId,
    userId: 'U1',
    message: '<@BOT> do the thing',
    createAt: Date.now(),
  };
}

class FakeClient extends EventEmitter {
  connected = 0;
  disconnected = 0;
  posts: string[] = [];
  async connect(): Promise<void> { this.connected++; }
  async disconnect(): Promise<void> { this.disconnected++; }
  async createPost(msg: string): Promise<unknown> { this.posts.push(msg); return {}; }
}

function makeDeps(overrides: Partial<ChannelDiscoveryDeps> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chdisc-'));
  const registered: Array<{ id: string; workingDir: string }> = [];
  const removed: string[] = [];
  const delivered: string[] = [];
  const alerts: string[] = [];
  const clients = new Map<string, FakeClient>();
  const deps: ChannelDiscoveryDeps = {
    platforms: new Map<string, PlatformClient>(),
    log: () => {},
    registerPlatform: (config, workingDir) => {
      registered.push({ id: config.id, workingDir });
      const c = new FakeClient();
      clients.set(config.id, c);
      // Contract: registerPlatform inserts into the live platform registry.
      deps.platforms.set(config.id, c as unknown as PlatformClient);
      return c as unknown as PlatformClient;
    },
    removePlatform: (platformId) => { removed.push(platformId); },
    deliverMessage: async (_c, post) => { delivered.push(post.id); },
    fetchChannelName: async (id) => `vvs-handbook-${id.toLowerCase()}`,
    listRepos: () => ['vvs-handbook'],
    ensureWorkspace: async () => {},
    teardownWorkspace: async () => 'removed' as const,
    alert: async (m) => { alerts.push(m); },
    listExtraWorkspaces: () => [],
    clearExtraWorkspaces: () => {},
    bindingsFile: path.join(tmp, 'bindings.json'),
    ...overrides,
  };
  return { deps, registered, removed, delivered, alerts, clients };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('channel discovery runtime', () => {
  it('cold mention spawns a derived instance, connects it, delivers the message, persists the binding', async () => {
    const { deps, registered, delivered, clients } = makeDeps();
    const rt = createChannelDiscoveryRuntime(deps);
    const parent = new FakeClient();
    rt.wireParent(parentConfig, parent as unknown as PlatformClient);

    const post = makePost('CNEW1');
    parent.emit('cold_channel_message', 'CNEW1', post, null);
    await flush();

    expect(registered.length).toBe(1);
    expect(registered[0].id).toBe('slack-vvs--ch-CNEW1');
    expect(clients.get('slack-vvs--ch-CNEW1')!.connected).toBe(1);
    expect(delivered).toEqual([post.id]);
    const saved = JSON.parse(fs.readFileSync(deps.bindingsFile, 'utf-8'));
    expect(saved.length).toBe(1);
    expect(saved[0].channelId).toBe('CNEW1');
  });

  it('second cold message for the same channel does not spawn twice', async () => {
    const { deps, registered } = makeDeps();
    const rt = createChannelDiscoveryRuntime(deps);
    const parent = new FakeClient();
    rt.wireParent(parentConfig, parent as unknown as PlatformClient);

    parent.emit('cold_channel_message', 'CNEW1', makePost('CNEW1'), null);
    await flush();
    parent.emit('cold_channel_message', 'CNEW1', makePost('CNEW1'), null);
    await flush();
    expect(registered.length).toBe(1);
  });

  it('channel_gone tears down and, when the verifier keeps the workspace, alerts', async () => {
    const { deps, removed, alerts } = makeDeps({ teardownWorkspace: async () => 'kept' as const });
    const rt = createChannelDiscoveryRuntime(deps);
    const parent = new FakeClient();
    rt.wireParent(parentConfig, parent as unknown as PlatformClient);

    parent.emit('cold_channel_message', 'CNEW1', makePost('CNEW1'), null);
    await flush();
    parent.emit('channel_gone', 'CNEW1', 'archived');
    await flush();

    expect(removed).toEqual(['slack-vvs--ch-CNEW1']);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('nothing was deleted');
    expect(rt.bindings().size).toBe(0);
  });

  it('teardown covers workon-recorded extra workspaces and clears only removed ones', async () => {
    const torn: string[] = [];
    const cleared: Array<{ ch: string; dirs: string[] }> = [];
    const { deps, alerts } = makeDeps({
      teardownWorkspace: async (ws) => {
        torn.push(ws.dir);
        return ws.dir.endsWith('--stuck') ? ('kept' as const) : ('removed' as const);
      },
      listExtraWorkspaces: () => [
        { kind: 'repo', dir: '/w/ch--vvs-handbook', repoRoot: '/r/vvs-handbook', branch: 'slack/x' },
        { kind: 'repo', dir: '/w/ch--stuck', repoRoot: '/r/vvs-handbook', branch: 'slack/y' },
      ],
      clearExtraWorkspaces: (ch, dirs) => { cleared.push({ ch, dirs }); },
    });
    const rt = createChannelDiscoveryRuntime(deps);
    const parent = new FakeClient();
    rt.wireParent(parentConfig, parent as unknown as PlatformClient);
    parent.emit('cold_channel_message', 'CNEW1', makePost('CNEW1'), null);
    await flush();
    parent.emit('channel_gone', 'CNEW1', 'archived');
    await flush();

    // primary + both extras all attempted
    expect(torn.length).toBe(3);
    // only the successfully removed extra is cleared from the sidecar
    expect(cleared).toEqual([{ ch: 'vvs-handbook-cnew1', dirs: ['/w/ch--vvs-handbook'] }]);
    // the stuck one produced an alert and was kept
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('--stuck');
  });

  it('boot reconstruction respawns instances from the bindings file', async () => {
    const first = makeDeps();
    const rt1 = createChannelDiscoveryRuntime(first.deps);
    const parent1 = new FakeClient();
    rt1.wireParent(parentConfig, parent1 as unknown as PlatformClient);
    parent1.emit('cold_channel_message', 'CNEW1', makePost('CNEW1'), null);
    await flush();

    // "restart": new runtime, same bindings file
    const second = makeDeps({ bindingsFile: first.deps.bindingsFile });
    const rt2 = createChannelDiscoveryRuntime(second.deps);
    const parent2 = new FakeClient();
    rt2.wireParent(parentConfig, parent2 as unknown as PlatformClient);
    await rt2.reconstructPersisted();
    await flush();

    expect(second.registered.length).toBe(1);
    expect(second.registered[0].id).toBe('slack-vvs--ch-CNEW1');
    // reconstruction must not re-deliver any message
    expect(second.delivered.length).toBe(0);
  });
});
