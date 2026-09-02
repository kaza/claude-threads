/**
 * voice-desk: the settled-text rule. See docs/voice-desk-spec.md § Replies.
 *
 * claude-threads streams by editing one post on the same `ts` for a whole
 * turn, and a tool that runs for ten seconds leaves that post quiet mid-turn.
 * There is no completion signal to read. So a message is delivered once its
 * text has been identical on QUIET_POLLS consecutive polls, and delivered
 * again, flagged `updated`, if it changes and settles again afterwards.
 */

export interface HistoryMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: Array<{ id: string }>;
}

export interface SettledReply {
  ts: string;
  text: string;
  /** True when this post was delivered before and has changed since. */
  updated: boolean;
}

/** Per candidate ts: last text seen, how many polls it has been unchanged, what was last delivered. */
export type SeenMap = Record<string, { text: string; quiet: number; delivered?: string }>;

export interface SettleInput {
  botUserId: string;
  seen: SeenMap;
  /** Only messages strictly newer than this Slack ts are candidates. */
  since: string;
}

/** Consecutive identical polls before a text counts as settled (~8 s at a 4 s cadence). */
export const QUIET_POLLS = 3;
export const MAX_REPLY_CHARS = 4000;
const TRUNCATION_NOTE = '… (truncated; the full text is in the channel)';

function newerThan(a: string, b: string): boolean {
  return parseFloat(a) > parseFloat(b);
}

function truncate(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return `${text.slice(0, MAX_REPLY_CHARS - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

/**
 * One poll's worth of history in, the replies that just settled out, plus the
 * updated `seen` map to feed into the next call. Pure.
 */
export function settle(history: HistoryMessage[], input: SettleInput): { settled: SettledReply[]; seen: SeenMap } {
  // Start from what we already know: a candidate that fell outside this
  // page (the page is the newest 50) keeps its quiet count and delivery state.
  const seen: SeenMap = Object.fromEntries(Object.entries(input.seen).filter(([ts]) => newerThan(ts, input.since)));
  const settled: SettledReply[] = [];

  // Slack bot-authored messages carry both `user` and `bot_id`; the exact
  // bot user id is the only filter (review finding: `!bot_id` dropped them all).
  const candidates = history
    .filter((m) => m.user === input.botUserId)
    .filter((m) => !m.subtype)
    .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0)
    .filter((m) => newerThan(m.ts, input.since))
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  for (const m of candidates) {
    const text = m.text as string;
    const previous = input.seen[m.ts];
    const quiet = previous && previous.text === text ? previous.quiet + 1 : 1;
    const delivered = previous?.delivered;
    if (quiet >= QUIET_POLLS && delivered !== text) {
      seen[m.ts] = { text, quiet, delivered: text };
      settled.push({ ts: m.ts, text: truncate(text), updated: delivered !== undefined });
    } else {
      seen[m.ts] = { text, quiet, delivered };
    }
  }

  return { settled, seen };
}
