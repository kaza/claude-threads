/**
 * Dynamic-channel discovery runtime (Slack).
 *
 * Owns the lifecycle of derived channel platform instances: live discovery
 * from a parent entry's 'cold_channel_message' events, boot reconstruction
 * from persisted bindings, and the teardown backstop ('channel_gone') with a
 * mechanical git verifier. Mirrors dm-discovery-runtime.ts; dependencies are
 * injected so the production code path is testable.
 *
 * The agent may *close* a task conversationally (commit/push as ordinary
 * session work); only this runtime ever *deletes*, and only after the
 * verifier proves clean-and-pushed. See docs/dynamic-channels-spec.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SlackPlatformConfig } from '../config/types.js';
import type { PlatformClient, PlatformPost, PlatformUser } from './index.js';
import {
  channelPlatformId,
  deriveChannelPlatformConfig,
  resolveChannelWorkspace,
  type ChannelWorkspace,
} from './channel-discovery.js';

/** Persisted binding: everything needed to reconstruct a derived instance. */
export interface ChannelBinding {
  channelId: string;
  channelName: string;
  platformId: string;
  workspace: ChannelWorkspace;
}

export interface ChannelDiscoveryDeps {
  platforms: Map<string, PlatformClient>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Create, register (UI + session manager + event wiring incl.
   * defaultWorkingDir) and return the client for a derived channel config.
   * MUST also insert the client into `platforms` — the runtime uses
   * `platforms.has(platformId)` as the liveness check for respawn decisions.
   */
  registerPlatform: (config: SlackPlatformConfig, workingDir: string, sharedEventSource: PlatformClient) => PlatformClient;
  /**
   * Tear a derived platform down host-side (kill its running sessions,
   * session mgr, UI row, parent routing). MUST have stopped any running
   * Claude session before resolving — the workspace verifier commits and
   * removes the worktree right after, and doing that under a live process
   * is a race.
   */
  removePlatform: (platformId: string, channelId: string) => void | Promise<void>;
  /** Deliver the triggering message through the production handler. */
  deliverMessage: (
    client: PlatformClient,
    post: PlatformPost,
    user: PlatformUser | null,
    platformId: string,
    workingDir: string,
  ) => Promise<void>;
  /** Channel-name lookup on the parent client. */
  fetchChannelName: (channelId: string) => Promise<string | null>;
  /** List candidate repo directory names under reposDir. */
  listRepos: (reposDir: string) => string[];
  /** Ensure the workspace exists (create worktree / scratch dir). */
  ensureWorkspace: (ws: ChannelWorkspace) => Promise<void>;
  /**
   * The teardown verifier: commit WIP + push + verify + remove worktree.
   * Returns 'removed' | 'kept' (kept = push failed or verification failed).
   */
  teardownWorkspace: (ws: ChannelWorkspace) => Promise<'removed' | 'kept'>;
  /** Post an operator-visible warning into the parent channel. */
  alert: (message: string) => Promise<void>;
  /**
   * Extra workspaces the `workon` script recorded for a channel (sidecar
   * file; the daemon only reads it). Keyed by channel NAME.
   */
  listExtraWorkspaces: (channelName: string) => ChannelWorkspace[];
  /** Clear handled sidecar entries (only the dirs actually removed). */
  clearExtraWorkspaces: (channelName: string, handledDirs: string[]) => void;
  /** Path of the bindings JSON file. */
  bindingsFile: string;
}

export interface ChannelDiscoveryRuntime {
  wireParent(parentConfig: SlackPlatformConfig, parentClient: PlatformClient): void;
  /**
   * Rebuild derived instances from persisted bindings. MUST be awaited before
   * session.initialize() — a platform that registers late misses its
   * session resume (review finding).
   */
  reconstructPersisted(): Promise<void>;
  /** Current bindings (for tests / status). */
  bindings(): ReadonlyMap<string, ChannelBinding>;
}

export function createChannelDiscoveryRuntime(deps: ChannelDiscoveryDeps): ChannelDiscoveryRuntime {
  const { log } = deps;
  /** channel id → binding */
  const byChannel = new Map<string, ChannelBinding>();
  /** channels whose spawn is in flight (dedupe concurrent cold messages) */
  const inFlight = new Set<string>();
  let parent: { config: SlackPlatformConfig; client: PlatformClient } | null = null;

  const loadBindings = (): void => {
    try {
      if (!fs.existsSync(deps.bindingsFile)) return;
      const raw = JSON.parse(fs.readFileSync(deps.bindingsFile, 'utf-8')) as ChannelBinding[];
      for (const b of raw) byChannel.set(b.channelId, b);
    } catch (err) {
      log('warn', `dynamic-channels: failed to load bindings: ${err}`);
    }
  };

  const saveBindings = (): void => {
    try {
      fs.mkdirSync(path.dirname(deps.bindingsFile), { recursive: true });
      const tmp = `${deps.bindingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...byChannel.values()], null, 2));
      fs.renameSync(tmp, deps.bindingsFile);
    } catch (err) {
      log('warn', `dynamic-channels: failed to save bindings: ${err}`);
    }
  };

  const spawn = async (
    binding: ChannelBinding,
    coldPost?: PlatformPost,
    coldUser?: PlatformUser | null,
  ): Promise<void> => {
    if (!parent) return;
    await deps.ensureWorkspace(binding.workspace);
    const config = deriveChannelPlatformConfig(
      parent.config,
      binding.channelId,
      binding.channelName,
      binding.workspace.dir,
    );
    // Share the parent's socket (never open a second one): the parent is a
    // constructor argument of the derived client, per the upstream shared event source.
    const client = deps.registerPlatform(config, binding.workspace.dir, parent.client);
    if (coldPost) {
      // The cold trigger is delivered manually below; seed the derived
      // client's dedupe so a Slack redelivery can't run the prompt twice.
      (client as PlatformClient & { seedProcessedMessage?: (ts: string) => void })
        .seedProcessedMessage?.(coldPost.id);
    }
    await client.connect();
    byChannel.set(binding.channelId, binding);
    saveBindings();
    log('info', `dynamic-channels: spawned ${binding.platformId} (#${binding.channelName}) → ${binding.workspace.dir}`);
    if (coldPost) {
      await deps.deliverMessage(client, coldPost, coldUser ?? null, binding.platformId, binding.workspace.dir);
    }
  };

  const onColdMessage = async (
    channelId: string,
    post: PlatformPost,
    user: PlatformUser | null,
  ): Promise<void> => {
    if (!parent) return;
    if (inFlight.has(channelId)) return;
    // A binding whose platform is actually live → nothing to do. A binding
    // whose platform is MISSING (failed boot reconstruction, crashed spawn)
    // must not poison the channel forever — respawn it (review finding).
    const existing = byChannel.get(channelId);
    if (existing && deps.platforms.has(existing.platformId)) return;
    inFlight.add(channelId);
    try {
      if (existing) {
        await spawn(existing, post, user);
        return;
      }
      const name = (await deps.fetchChannelName(channelId)) ?? channelId.toLowerCase();
      const dyn = parent.config.dynamicChannels;
      if (!dyn) return;
      const workspace = resolveChannelWorkspace(name, dyn, deps.listRepos(dyn.reposDir));
      const binding: ChannelBinding = {
        channelId,
        channelName: name,
        platformId: channelPlatformId(parent.config.id, channelId),
        workspace,
      };
      await spawn(binding, post, user);
    } catch (err) {
      log('error', `dynamic-channels: spawn failed for ${channelId}: ${err}`);
      await deps.alert(`⚠️ dynamic channel spawn failed for <#${channelId}>: ${err}`).catch(() => {});
    } finally {
      inFlight.delete(channelId);
    }
  };

  const onChannelGone = async (channelId: string, reason: 'archived' | 'bot_removed'): Promise<void> => {
    const binding = byChannel.get(channelId);
    if (!binding) return;
    log('info', `dynamic-channels: #${binding.channelName} ${reason} — tearing down ${binding.platformId}`);
    await deps.removePlatform(binding.platformId, binding.channelId);
    byChannel.delete(channelId);
    saveBindings();
    // Primary workspace plus everything `workon` recorded for this channel.
    const extras = deps.listExtraWorkspaces(binding.channelName);
    const all = [binding.workspace, ...extras];
    const removedExtraDirs: string[] = [];
    const kept: string[] = [];
    for (const ws of all) {
      try {
        const verdict = await deps.teardownWorkspace(ws);
        if (verdict === 'removed') {
          if (ws !== binding.workspace) removedExtraDirs.push(ws.dir);
        } else {
          kept.push(ws.dir);
        }
      } catch (err) {
        log('error', `dynamic-channels: teardown error for #${binding.channelName} (${ws.dir}): ${err}`);
        kept.push(ws.dir);
      }
    }
    deps.clearExtraWorkspaces(binding.channelName, removedExtraDirs);
    if (kept.length > 0) {
      await deps.alert(
        `⚠️ #${binding.channelName} ${reason}: ${kept.length} workspace(s) could not be safely removed (push failed or dirty state persisted). Kept: ${kept.join(', ')} — nothing was deleted.`,
      ).catch(() => {});
    }
  };

  return {
    wireParent(parentConfig, parentClient) {
      parent = { config: parentConfig, client: parentClient };
      parentClient.on('cold_channel_message', (channelId, post, user) => {
        void onColdMessage(channelId, post, user);
      });
      parentClient.on('channel_gone', (channelId, reason) => {
        void onChannelGone(channelId, reason);
      });
    },
    async reconstructPersisted() {
      loadBindings();
      await Promise.allSettled(
        [...byChannel.values()].map((binding) =>
          spawn(binding).catch((err) =>
            log('error', `dynamic-channels: boot reconstruction failed for #${binding.channelName}: ${err}`),
          ),
        ),
      );
    },
    bindings() {
      return byChannel;
    },
  };
}
