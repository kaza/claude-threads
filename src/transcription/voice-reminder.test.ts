import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ALWAYS_SPEAK_REMINDER, alwaysSpeakReminder, isAlwaysSpeakOn, speakKey } from './voice-prompt.js';

let stateDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'speak-state-'));
  prevEnv = process.env.CLAUDE_THREADS_SPEAK_DIR;
  process.env.CLAUDE_THREADS_SPEAK_DIR = stateDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.CLAUDE_THREADS_SPEAK_DIR;
  else process.env.CLAUDE_THREADS_SPEAK_DIR = prevEnv;
  await rm(stateDir, { recursive: true, force: true });
});

describe('speakKey', () => {
  test('reduces a composite session id to one filename-safe segment', () => {
    expect(speakKey('slack-vvs--ch-C0BU9JM6ASW:dcm:slack-vvs--ch-C0BU9JM6ASW')).toBe('slack-vvs--ch-C0BU9JM6ASW_dcm_slack-vvs--ch-C0BU9JM6ASW');
    expect(speakKey('mattermost-main:1717000000.123')).toBe('mattermost-main_1717000000.123');
  });

  test('matches what the say script derives from the same env value', () => {
    // scripts/say: tr -c 'A-Za-z0-9._-' '_' on CLAUDE_THREADS_SPEAK_KEY
    expect(speakKey('a b/c:d')).toBe('a_b_c_d');
  });
});

describe('alwaysSpeakReminder', () => {
  test('is empty while the switch is off', () => {
    expect(isAlwaysSpeakOn('slack:quiet')).toBe(false);
    expect(alwaysSpeakReminder('slack:quiet')).toBe('');
  });

  test('carries the reminder once say --on left its marker for the session', async () => {
    await writeFile(join(stateDir, speakKey('slack:loud')), '');

    expect(isAlwaysSpeakOn('slack:loud')).toBe(true);
    expect(alwaysSpeakReminder('slack:loud')).toBe(`${ALWAYS_SPEAK_REMINDER}\n\n`);
  });

  test('another session is unaffected', async () => {
    await writeFile(join(stateDir, speakKey('slack:loud')), '');

    expect(isAlwaysSpeakOn('slack:other')).toBe(false);
  });

  test('a missing state dir means off, not an error', () => {
    process.env.CLAUDE_THREADS_SPEAK_DIR = join(stateDir, 'never-created');

    expect(isAlwaysSpeakOn('slack:loud')).toBe(false);
  });
});
