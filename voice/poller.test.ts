/**
 * voice-desk: the settled-text rule.
 * See docs/voice-desk-spec.md § Replies.
 */

import { describe, test, expect } from 'bun:test';
import { QUIET_POLLS, settle, type HistoryMessage, type SeenMap } from './poller.js';

const BOT = 'UBOT';

function bot(ts: string, text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { ts, user: BOT, text, ...extra };
}

/** Run `settle` over a sequence of polls, returning the deliveries of each poll. */
function polls(sequence: HistoryMessage[][], since = '1.0') {
  let seen: SeenMap = {};
  return sequence.map((history) => {
    const out = settle(history, { botUserId: BOT, seen, since });
    seen = out.seen;
    return out.settled;
  });
}

describe('settle: which history messages count as finished agent replies', () => {
  test('a bot message is delivered once its text has been identical on three consecutive polls', () => {
    const history = [bot('1.1', 'Working on it')];

    const deliveries = polls([history, history, history, history]);

    expect(deliveries).toEqual([[], [], [{ ts: '1.1', text: 'Working on it', updated: false }], []]);
  });

  test('a change resets the quiet count', () => {
    const deliveries = polls([
      [bot('1.1', 'Work')],
      [bot('1.1', 'Working')],
      [bot('1.1', 'Working on it')],
      [bot('1.1', 'Working on it')],
      [bot('1.1', 'Working on it')],
    ]);

    expect(deliveries.slice(0, 4)).toEqual([[], [], [], []]);
    expect(deliveries[4]).toEqual([{ ts: '1.1', text: 'Working on it', updated: false }]);
  });

  test('a delivered post that changes again is delivered again, flagged updated', () => {
    const quiet = Array(QUIET_POLLS).fill([bot('1.1', 'Ran the tests.')]);
    const changed = Array(QUIET_POLLS).fill([bot('1.1', 'Ran the tests.\nOpened the PR.')]);

    const deliveries = polls([...quiet, ...changed]);

    expect(deliveries[QUIET_POLLS - 1]).toEqual([{ ts: '1.1', text: 'Ran the tests.', updated: false }]);
    expect(deliveries[2 * QUIET_POLLS - 1]).toEqual([{ ts: '1.1', text: 'Ran the tests.\nOpened the PR.', updated: true }]);
    expect(deliveries.filter((d) => d.length > 0)).toHaveLength(2);
  });

  test('humans, other bots, file-only posts and subtype messages are ignored', () => {
    const history = [
      { ts: '1.1', user: 'UHUMAN', text: 'hello' },
      { ts: '1.2', user: 'UOTHERBOT', bot_id: 'B1', text: 'spam' },
      bot('1.3', '', { files: [{ id: 'F1' }] }),
      bot('1.4', 'joined', { subtype: 'channel_join' }),
      bot('1.5', 'a real reply'),
    ];

    const deliveries = polls(Array(QUIET_POLLS).fill(history));

    expect(deliveries[QUIET_POLLS - 1]).toEqual([{ ts: '1.5', text: 'a real reply', updated: false }]);
  });

  test('messages at or before the start timestamp are never delivered', () => {
    const history = [bot('1.0', 'old'), bot('1.1', 'new')];

    const deliveries = polls(Array(QUIET_POLLS).fill(history));

    expect(deliveries[QUIET_POLLS - 1]).toEqual([{ ts: '1.1', text: 'new', updated: false }]);
  });

  test('several settled posts come back together in ts order', () => {
    const history = [bot('1.3', 'third'), bot('1.1', 'first'), bot('1.2', 'second')];

    const deliveries = polls(Array(QUIET_POLLS).fill(history));

    expect(deliveries[QUIET_POLLS - 1].map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  test('long text is truncated with a note', () => {
    const long = 'x'.repeat(5000);

    const deliveries = polls(Array(QUIET_POLLS).fill([bot('1.1', long)]));

    const delivered = deliveries[QUIET_POLLS - 1][0];
    expect(delivered.text.length).toBeLessThan(4100);
    expect(delivered.text.endsWith('… (truncated; the full text is in the channel)')).toBe(true);
  });

  test('a message that disappears from history is forgotten', () => {
    const first = settle([bot('1.1', 'gone soon')], { botUserId: BOT, seen: {}, since: '1.0' });
    const second = settle([], { botUserId: BOT, seen: first.seen, since: '1.0' });

    expect(second.seen).toEqual({});
  });
});
