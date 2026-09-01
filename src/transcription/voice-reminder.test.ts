import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ALWAYS_SPEAK_REMINDER, alwaysSpeakReminder, channelFromWorkingDir, isAlwaysSpeakOn } from './voice-prompt.js';

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

describe('channelFromWorkingDir', () => {
  test('a scratch dir is its own channel', () => {
    expect(channelFromWorkingDir('/home/herder/scratch/fix-backfill')).toBe('fix-backfill');
  });

  test('a worktree named <channel>--<repo> belongs to the channel', () => {
    expect(channelFromWorkingDir('/home/herder/worktrees/fix-backfill--vvs-trading-platform')).toBe('fix-backfill');
  });
});

describe('alwaysSpeakReminder', () => {
  test('is empty while the switch is off', () => {
    expect(isAlwaysSpeakOn('/home/herder/scratch/quiet-task')).toBe(false);
    expect(alwaysSpeakReminder('/home/herder/scratch/quiet-task')).toBe('');
  });

  test('carries the reminder once say --on left its marker for the channel', async () => {
    await writeFile(join(stateDir, 'loud-task'), '');

    expect(isAlwaysSpeakOn('/home/herder/scratch/loud-task')).toBe(true);
    expect(alwaysSpeakReminder('/home/herder/scratch/loud-task')).toBe(`${ALWAYS_SPEAK_REMINDER}\n\n`);
  });

  test('a worktree of the channel sees the same switch', async () => {
    await writeFile(join(stateDir, 'loud-task'), '');

    expect(isAlwaysSpeakOn('/home/herder/worktrees/loud-task--some-repo')).toBe(true);
  });

  test('another channel is unaffected', async () => {
    await writeFile(join(stateDir, 'loud-task'), '');

    expect(isAlwaysSpeakOn('/home/herder/scratch/other-task')).toBe(false);
  });

  test('a missing state dir means off, not an error', async () => {
    await rm(stateDir, { recursive: true, force: true });
    await mkdir(stateDir); // afterEach expects it; recreate after the check below
    process.env.CLAUDE_THREADS_SPEAK_DIR = join(stateDir, 'never-created');

    expect(isAlwaysSpeakOn('/home/herder/scratch/loud-task')).toBe(false);
  });
});
