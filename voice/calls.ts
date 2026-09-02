/**
 * voice-desk: the call lifecycle. See docs/voice-desk-spec.md § Routes,
 * § Replies, § Call card.
 *
 * A call is one person's voice leg into one task channel. Calls in the same
 * channel share one poller; each call has its own mailbox of settled agent
 * replies. Nothing the model says can choose a channel or move a cursor.
 */

import { mintEphemeralToken, type GeminiDeps } from './gemini.js';
import { buildSetup } from './prompt.js';
import { QUIET_POLLS, settle, type SeenMap, type SettledReply } from './poller.js';
import type { Store, StoredCall, StoredUser } from './session.js';
import {
  SlackError,
  callParticipantsAdd,
  callParticipantsRemove,
  callsAdd,
  callsEnd,
  history,
  isTokenDead,
  postCallBlock,
  postMessage,
  type SlackDeps,
} from './slack.js';

export interface CallsDeps {
  store: Store;
  slack: SlackDeps;
  gemini: GeminiDeps;
  botUserId: string;
  publicUrl: string;
  model: string;
  voiceName: string;
  now: () => number;
  log: (line: string) => void;
  /** Tunables, all with production defaults. */
  pollIntervalMs?: number;
  waitDeadlineMs?: number;
  postsPerMinute?: number;
  idleMs?: number;
  /** Called when a user's token turns out to be dead; the app expires their cookie next time. */
  onTokenDead?: (userId: string) => void;
  /**
   * The model honours NON_BLOCKING tools (2.5 native-audio). False for a
   * sequential model (3.1 Flash Live): short waits, no willContinue, and the
   * instruction stops promising to chat during the wait.
   */
  asyncTools?: boolean;
}

export type ToolResult =
  | { ok: true; result: Record<string, unknown>; scheduling: 'SILENT' | 'INTERRUPT' | 'WHEN_IDLE'; willContinue?: boolean }
  | { ok: false; error: string; scheduling: 'INTERRUPT' };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Mailbox {
  replies: SettledReply[];
  waiters: Array<() => void>;
  /** Slack ts at which this call started; earlier replies are never delivered. */
  startTs: string;
  /**
   * Gemini call ids already answered or in flight, with their results.
   * The entry is reserved BEFORE the Slack call (a promise), so a duplicate
   * delivery arriving mid-flight waits for the same result instead of
   * posting twice (review finding 6).
   */
  results: Map<string, Promise<ToolResult>>;
}

interface ChannelPoller {
  seen: SeenMap;
  since: string;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
}

/** A delivered post older than this is assumed final; the poll cursor may move past it. */
const EDIT_HORIZON_MS = 10 * 60 * 1000;

function slackTs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
}

export class Calls {
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly pollers = new Map<string, ChannelPoller>();
  /** post_to_channel timestamps per user: the budget is per person, across their calls. */
  private readonly postTimes = new Map<string, number[]>();
  /** Card operations per channel run one at a time: two first calls must not create two cards. */
  private readonly cardLocks = new Map<string, Promise<void>>();
  /** Workspace-wide: no Slack polling before this time (429 Retry-After). */
  private cooldownUntil = 0;
  private reaper?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: CallsDeps) {}

  private get pollIntervalMs() { return this.deps.pollIntervalMs ?? 4000; }
  private get waitDeadlineMs() { return this.deps.waitDeadlineMs ?? 25_000; }
  private get postsPerMinute() { return this.deps.postsPerMinute ?? 20; }
  private get idleMs() { return this.deps.idleMs ?? 30 * 60 * 1000; }
  private get asyncTools() { return this.deps.asyncTools ?? true; }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async create(user: StoredUser, channel: string): Promise<{ callId: string; token: string; setup: unknown }> {
    const callId = randomId();
    const now = this.deps.now();
    // Mint first: a Gemini failure then leaves no card, no stored call, no poller.
    const minted = await this.mint(callId);
    await this.withCardLock(channel, () => this.joinCard(user, channel));
    await this.deps.store.update((s) => {
      s.calls[callId] = { callId, userId: user.userId, channel, createdAt: now, lastActivityAt: now };
    });
    this.mailboxes.set(callId, { replies: [], waiters: [], startTs: slackTs(now), results: new Map() });
    this.ensurePoller(channel);
    this.deps.log(`call=${callId} user=${user.userId} channel=${channel} start`);
    return { callId, ...minted };
  }

  /** A fresh one-use token for a reconnect; the resumption handle is passed through. */
  async token(user: StoredUser, callId: string, resumeHandle?: string): Promise<{ token: string; setup: unknown }> {
    this.owned(user, callId);
    await this.touch(callId);
    return this.mint(callId, resumeHandle);
  }

  private async mint(callId: string, resumeHandle?: string): Promise<{ token: string; setup: unknown }> {
    const started = this.deps.now();
    const opts = { model: this.deps.model, voiceName: this.deps.voiceName, resumeHandle, asyncTools: this.asyncTools };
    const setup = buildSetup(opts);
    const minted = await mintEphemeralToken(this.deps.gemini, opts);
    this.deps.log(`call=${callId} token minted in ${this.deps.now() - started}ms${resumeHandle ? ' (resume)' : ''}`);
    return { token: minted.name, setup };
  }

  async end(user: StoredUser, callId: string): Promise<void> {
    const call = this.owned(user, callId);
    await this.forget(call, user);
  }

  /** Every live call of one person, e.g. on logout or a dead token. */
  async endAllForUser(user: StoredUser): Promise<void> {
    for (const call of Object.values(this.deps.store.snapshot().calls).filter((c) => c.userId === user.userId)) {
      await this.forget(call, user);
    }
  }

  private async forget(call: StoredCall, user?: StoredUser): Promise<void> {
    const mailbox = this.mailboxes.get(call.callId);
    this.mailboxes.delete(call.callId);
    for (const wake of mailbox?.waiters ?? []) wake();
    await this.deps.store.update((s) => { delete s.calls[call.callId]; });
    const remaining = Object.values(this.deps.store.snapshot().calls).filter((c) => c.channel === call.channel);
    if (remaining.length === 0) this.stopPoller(call.channel);
    const userStillOnChannel = remaining.some((c) => c.userId === call.userId);
    await this.withCardLock(call.channel, () => this.leaveCard(call, user, remaining.length === 0, userStillOnChannel));
    this.deps.log(`call=${call.callId} user=${call.userId} channel=${call.channel} end`);
  }

  /**
   * On boot: nothing is live, so every persisted call is stale and every
   * card should be ended. A card whose end fails stays recorded so the next
   * boot (or reaper) tries again; a card without a usable owner token is
   * unreachable and dropped with a log line.
   */
  async bootCleanup(): Promise<void> {
    const state = this.deps.store.snapshot();
    const ended: string[] = [];
    for (const card of Object.values(state.cards)) {
      const owner = state.users[card.userId];
      if (!owner) {
        this.deps.log(`boot: card ${card.slackCallId} in ${card.channel} has no owner token; dropping the record`);
        ended.push(card.channel);
        continue;
      }
      try {
        await callsEnd(this.deps.slack, owner.token, card.slackCallId);
        this.deps.log(`boot: ended stale card ${card.slackCallId} in ${card.channel}`);
        ended.push(card.channel);
      } catch (err) {
        this.deps.log(`boot: could not end card ${card.slackCallId}, keeping it for a retry: ${(err as Error).message}`);
      }
    }
    await this.deps.store.update((s) => { s.calls = {}; for (const ch of ended) delete s.cards[ch]; });
  }

  startReaper(intervalMs = 60_000): void {
    this.reaper = setInterval(() => void this.reap(), intervalMs);
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    for (const channel of [...this.pollers.keys()]) this.stopPoller(channel);
  }

  async reap(): Promise<void> {
    const cutoff = this.deps.now() - this.idleMs;
    for (const call of Object.values(this.deps.store.snapshot().calls)) {
      if (call.lastActivityAt < cutoff) {
        this.deps.log(`call=${call.callId} idle since ${new Date(call.lastActivityAt).toISOString()}, reaping`);
        await this.forget(call, this.deps.store.snapshot().users[call.userId]);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  async tool(user: StoredUser, callId: string, invocation: { id: string; name: string; args: Record<string, unknown> }): Promise<ToolResult> {
    const call = this.owned(user, callId);
    const mailbox = this.mailbox(callId);
    await this.touch(callId);
    const started = this.deps.now();
    const result = await this.dispatch(user, call, mailbox, invocation);
    this.deps.log(`call=${callId} tool=${invocation.name} id=${invocation.id} ok=${result.ok} ${this.deps.now() - started}ms`);
    return result;
  }

  private async dispatch(user: StoredUser, call: StoredCall, mailbox: Mailbox, inv: { id: string; name: string; args: Record<string, unknown> }): Promise<ToolResult> {
    switch (inv.name) {
      case 'post_to_channel':
        return this.once(mailbox, inv.id, () => this.postToChannel(user, call, mailbox, inv.args));
      case 'wait_for_reply':
        return this.waitForReply(mailbox);
      case 'end_call':
        return this.once(mailbox, inv.id, async () => {
          await this.forget(call, user);
          return { ok: true, result: { ended: true }, scheduling: 'WHEN_IDLE' } as ToolResult;
        });
      default:
        throw new HttpError(400, `unknown tool: ${inv.name}`);
    }
  }

  /** Reserve the Gemini call id before running, so a concurrent duplicate joins the same promise. */
  private once(mailbox: Mailbox, id: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const existing = mailbox.results.get(id);
    if (existing) return existing;
    const pending = run();
    mailbox.results.set(id, pending);
    pending.catch(() => mailbox.results.delete(id)); // a thrown error is not a result to replay
    return pending;
  }

  private async postToChannel(user: StoredUser, call: StoredCall, mailbox: Mailbox, args: Record<string, unknown>): Promise<ToolResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) throw new HttpError(400, 'post_to_channel needs text');
    if (text.length > 2000) throw new HttpError(400, 'post_to_channel text over 2000 characters');
    const now = this.deps.now();
    const recent = (this.postTimes.get(user.userId) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= this.postsPerMinute) throw new HttpError(429, 'too many posts this minute');
    recent.push(now);
    this.postTimes.set(user.userId, recent);
    try {
      const posted = await postMessage(this.deps.slack, user.token, call.channel, `<@${this.deps.botUserId}> ${text}`);
      this.deps.log(`call=${call.callId} slack chat.postMessage ok ts=${posted.ts}`);
      return { ok: true, result: { posted: true }, scheduling: 'SILENT' };
    } catch (err) {
      return this.slackFailure(user, err, 'chat.postMessage', call.callId);
    }
  }

  private waitForReply(mailbox: Mailbox): Promise<ToolResult> {
    return new Promise((resolve) => {
      const deliver = () => {
        const replies = mailbox.replies.splice(0, mailbox.replies.length);
        resolve({ ok: true, result: { replies }, scheduling: 'INTERRUPT', willContinue: false });
      };
      if (mailbox.replies.length > 0) return deliver();
      const timer = setTimeout(() => {
        mailbox.waiters = mailbox.waiters.filter((w) => w !== wake);
        // Async model: the function stays open (willContinue). Sequential model:
        // this IS the final answer, and the model is told to call again.
        resolve({ ok: true, result: { waiting: true }, scheduling: 'SILENT', willContinue: this.asyncTools });
      }, this.waitDeadlineMs);
      const wake = () => {
        clearTimeout(timer);
        if (mailbox.replies.length > 0) deliver();
        else resolve({ ok: true, result: { waiting: true, ended: true }, scheduling: 'SILENT', willContinue: false });
      };
      mailbox.waiters.push(wake);
    });
  }

  private slackFailure(user: StoredUser, err: unknown, method: string, callId: string): ToolResult {
    if (err instanceof SlackError) {
      this.deps.log(`call=${callId} slack ${method} error=${err.code}${err.retryAfterSeconds ? ` retry-after=${err.retryAfterSeconds}` : ''}`);
      if (isTokenDead(err)) {
        this.deps.onTokenDead?.(user.userId);
        throw new HttpError(401, 'Slack token no longer valid; sign in again');
      }
      return { ok: false, error: err.message, scheduling: 'INTERRUPT' };
    }
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private ensurePoller(channel: string): void {
    if (this.pollers.has(channel)) return;
    const poller: ChannelPoller = { seen: {}, since: slackTs(this.deps.now()), inFlight: false };
    this.pollers.set(channel, poller);
    this.schedule(channel);
  }

  private stopPoller(channel: string): void {
    const poller = this.pollers.get(channel);
    if (poller?.timer) clearTimeout(poller.timer);
    this.pollers.delete(channel);
  }

  private schedule(channel: string): void {
    const poller = this.pollers.get(channel);
    if (!poller) return;
    const jitter = Math.floor(Math.random() * 500);
    const wait = Math.max(this.pollIntervalMs + jitter, this.cooldownUntil - this.deps.now());
    poller.timer = setTimeout(() => void this.pollOnce(channel).finally(() => this.schedule(channel)), wait);
  }

  /** One poll of one channel. Exposed so tests drive it without timers. */
  async pollOnce(channel: string): Promise<void> {
    const poller = this.pollers.get(channel);
    if (!poller || poller.inFlight) return;
    if (this.deps.now() < this.cooldownUntil) return;
    const state = this.deps.store.snapshot();
    const calls = Object.values(state.calls).filter((c) => c.channel === channel);
    const tokenOwner = calls.map((c) => state.users[c.userId]).find((u) => u);
    if (!tokenOwner) return;
    poller.inFlight = true;
    try {
      const messages = await history(this.deps.slack, tokenOwner.token, channel, poller.since);
      const { settled, seen } = settle(messages, { botUserId: this.deps.botUserId, seen: poller.seen, since: poller.since });
      poller.seen = seen;
      // Advance the cursor past posts that are old, delivered, and unchanged
      // since delivery, so a long session does not re-fetch its whole history
      // on every poll. A post still being edited, or edited after delivery,
      // stays visible until it re-settles. The accepted limit (spec): an edit
      // to a post that was quiet for more than ten minutes is not re-read.
      const horizon = (this.deps.now() - EDIT_HORIZON_MS) / 1000;
      for (const ts of Object.keys(seen)) {
        const entry = seen[ts];
        const finished = entry.delivered !== undefined && entry.delivered === entry.text && entry.quiet >= QUIET_POLLS;
        if (finished && parseFloat(ts) < horizon && parseFloat(ts) > parseFloat(poller.since)) {
          poller.since = ts;
          delete poller.seen[ts];
        }
      }
      for (const call of calls) {
        const mailbox = this.mailboxes.get(call.callId);
        if (!mailbox) continue;
        const mine = settled.filter((r) => parseFloat(r.ts) > parseFloat(mailbox.startTs));
        if (mine.length === 0) continue;
        mailbox.replies.push(...mine);
        const waiters = mailbox.waiters.splice(0, mailbox.waiters.length);
        for (const wake of waiters) wake();
      }
    } catch (err) {
      if (err instanceof SlackError && err.code === 'ratelimited') {
        this.cooldownUntil = this.deps.now() + (err.retryAfterSeconds ?? 1) * 1000;
        this.deps.log(`slack conversations.history 429; all polling paused for ${err.retryAfterSeconds ?? 1}s`);
      } else if (isTokenDead(err)) {
        this.deps.log(`poll ${channel}: token of ${tokenOwner.userId} is dead`);
        this.deps.onTokenDead?.(tokenOwner.userId);
      } else {
        this.deps.log(`poll ${channel} failed: ${(err as Error).message}`);
      }
    } finally {
      poller.inFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Call card
  // ---------------------------------------------------------------------------

  /** Serialise card work per channel. */
  private withCardLock<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const previous = this.cardLocks.get(channel) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.cardLocks.set(channel, run.then(() => undefined, () => undefined));
    return run;
  }

  private async joinCard(user: StoredUser, channel: string): Promise<void> {
    const existing = this.deps.store.snapshot().cards[channel];
    if (existing) {
      const alreadyOn = Object.values(this.deps.store.snapshot().calls).some((c) => c.channel === channel && c.userId === user.userId);
      if (alreadyOn) return; // a second tab: one participant per person on the card
      try {
        await callParticipantsAdd(this.deps.slack, user.token, existing.slackCallId, user.userId);
      } catch (err) {
        if (isTokenDead(err)) {
          this.deps.onTokenDead?.(user.userId);
          throw new HttpError(401, 'Slack token no longer valid; sign in again');
        }
        this.deps.log(`card ${existing.slackCallId}: participants.add failed: ${(err as Error).message}`);
      }
      return;
    }
    const created = await callsAdd(this.deps.slack, user.token, {
      externalUniqueId: `${channel}-${this.deps.now()}`,
      joinUrl: `${this.deps.publicUrl}/?channel=${encodeURIComponent(channel)}`,
      title: 'Voice call with the agent',
      userId: user.userId,
    });
    try {
      await postCallBlock(this.deps.slack, user.token, channel, created.id);
    } catch (err) {
      await callsEnd(this.deps.slack, user.token, created.id).catch(() => undefined);
      throw err;
    }
    await this.deps.store.update((s) => {
      s.cards[channel] = { channel, slackCallId: created.id, userId: user.userId, createdAt: this.deps.now() };
    });
  }

  private async leaveCard(call: StoredCall, user: StoredUser | undefined, last: boolean, userStillOnChannel: boolean): Promise<void> {
    const card = this.deps.store.snapshot().cards[call.channel];
    if (!card) return;
    const token = user?.token ?? this.deps.store.snapshot().users[card.userId]?.token;
    if (!token) return;
    try {
      if (last) {
        await callsEnd(this.deps.slack, token, card.slackCallId);
        await this.deps.store.update((s) => { delete s.cards[call.channel]; });
      } else if (!userStillOnChannel) {
        await callParticipantsRemove(this.deps.slack, token, card.slackCallId, call.userId);
      }
    } catch (err) {
      this.deps.log(`card ${card.slackCallId}: ${last ? 'end' : 'participants.remove'} failed: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------

  private owned(user: StoredUser, callId: string): StoredCall {
    const call = this.deps.store.snapshot().calls[callId];
    if (!call || call.userId !== user.userId) throw new HttpError(404, 'no such call');
    return call;
  }

  private mailbox(callId: string): Mailbox {
    const mailbox = this.mailboxes.get(callId);
    if (!mailbox) throw new HttpError(404, 'no such call');
    return mailbox;
  }

  private async touch(callId: string): Promise<void> {
    const now = this.deps.now();
    await this.deps.store.update((s) => { if (s.calls[callId]) s.calls[callId].lastActivityAt = now; });
  }
}
