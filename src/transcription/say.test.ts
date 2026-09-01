/**
 * scripts/say — driven end to end with a stub `curl` on PATH and a
 * temporary daemon config. See docs/voice-replies-spec.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SAY = resolve(import.meta.dir, '../../scripts/say');

let root: string;
let binDir: string;
let stateDir: string;
let outDir: string;
let configPath: string;
let curlLog: string;

/**
 * A `curl` that records its argv, the contents of any -K config file (where
 * the key header travels) and its stdin (where the JSON body travels), writes
 * a fake mp3 to the -o path, and prints the status it is told to.
 */
async function installStubCurl(status = '200', body = 'ID3fake-mp3'): Promise<void> {
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${curlLog}"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "-K" ]; then { echo "--config:"; cat "$a"; } >> "${curlLog}"; fi
  prev="$a"
done
{ echo "--stdin:"; cat; } >> "${curlLog}"
printf '%s' '${body}' > "$out"
printf '%s' '${status}'
`;
  await writeFile(join(binDir, 'curl'), script, { mode: 0o755 });
  await chmod(join(binDir, 'curl'), 0o755);
}

async function writeConfig(yaml: string): Promise<void> {
  await writeFile(configPath, yaml, { mode: 0o600 });
}

async function runSay(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([SAY, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SAY_CONFIG: configPath,
      SAY_STATE_DIR: stateDir,
      SAY_OUT_DIR: outDir,
      SAY_API_URL: 'https://el.test/v1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'say-test-'));
  binDir = join(root, 'bin');
  stateDir = join(root, 'state');
  outDir = join(root, 'out');
  configPath = join(root, 'config.yaml');
  curlLog = join(root, 'curl.argv');
  await Promise.all([mkdir(binDir), mkdir(outDir)]);
  await installStubCurl();
  await writeConfig('transcription:\n  provider: elevenlabs\n  apiKey: sk-shared\nspeech:\n  voiceId: voice-123\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('say "text"', () => {
  test('writes the mp3, prints its path, and calls ElevenLabs with the voice, key header and default model', async () => {
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    const result = await runSay(['hello team'], channelDir);

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(outDir)).toBe(true);
    expect(result.stdout.endsWith('.mp3')).toBe(true);
    expect(await readFile(result.stdout, 'utf8')).toBe('ID3fake-mp3');
    const argv = await readFile(curlLog, 'utf8');
    expect(argv).toContain('https://el.test/v1/text-to-speech/voice-123?output_format=mp3_44100_128');
    expect(argv).toContain('header = "xi-api-key: sk-shared"');
    expect(argv).toContain('"model_id": "eleven_multilingual_v2"');
    expect(argv).toContain('"text": "hello team"');
  });

  test('the key and the text never appear in curl\'s argv', async () => {
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    await runSay(['secret plans'], channelDir);

    const argv = (await readFile(curlLog, 'utf8')).split('--config:')[0];
    expect(argv).not.toContain('sk-shared');
    expect(argv).not.toContain('secret plans');
  });

  test('prefers speech.apiKey and speech.model when set', async () => {
    await writeConfig('transcription:\n  apiKey: sk-shared\nspeech:\n  voiceId: v\n  apiKey: sk-voice\n  model: eleven_flash_v2_5\n');
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    const result = await runSay(['hi'], channelDir);

    expect(result.code).toBe(0);
    const argv = await readFile(curlLog, 'utf8');
    expect(argv).toContain('header = "xi-api-key: sk-voice"');
    expect(argv).toContain('"model_id": "eleven_flash_v2_5"');
  });

  test('a non-200 answer is an error with the body excerpt and leaves no file behind', async () => {
    await installStubCurl('401', '{"detail":{"status":"invalid_api_key"}}');
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    const result = await runSay(['hi'], channelDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ElevenLabs HTTP 401');
    expect(result.stderr).toContain('invalid_api_key');
    expect(await readdir(outDir)).toEqual([]);
  });

  test('refuses text over the limit and says to summarise', async () => {
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    const result = await runSay(['x'.repeat(2501)], channelDir);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('speak a summary');
    expect(existsSync(curlLog)).toBe(false);
  });

  test('a missing voice id is a config error, not an API call', async () => {
    await writeConfig('transcription:\n  apiKey: sk-shared\n');
    const channelDir = join(root, 'scratch', 'my-task');
    await mkdir(channelDir, { recursive: true });

    const result = await runSay(['hi'], channelDir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('speech.voiceId');
    expect(existsSync(curlLog)).toBe(false);
  });
});

describe('say inside a git checkout', () => {
  test('writes the mp3 into the working directory by default and excludes the pattern from git', async () => {
    const worktree = join(root, 'worktrees', 'fix-backfill--repo');
    await mkdir(worktree, { recursive: true });
    const init = Bun.spawn(['git', 'init', '-q'], { cwd: worktree });
    await init.exited;

    const proc = Bun.spawn([SAY, 'summary'], {
      cwd: worktree,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, SAY_CONFIG: configPath, SAY_STATE_DIR: stateDir, SAY_API_URL: 'https://el.test/v1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const printed = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    // bash resolves $PWD through getcwd(), so /var/… becomes /private/var/… on macOS
    expect(printed.startsWith(realpathSync(worktree))).toBe(true);
    expect(existsSync(printed)).toBe(true);
    expect(await readFile(join(worktree, '.git', 'info', 'exclude'), 'utf8')).toContain('say-*.mp3');
    const status = Bun.spawn(['git', 'status', '--porcelain'], { cwd: worktree, stdout: 'pipe' });
    expect((await new Response(status.stdout).text()).trim()).toBe('');
  });
});

describe('say --on / --off / --status', () => {
  test('the switch is per channel, derived from the workspace basename', async () => {
    const taskA = join(root, 'scratch', 'task-a');
    const taskB = join(root, 'scratch', 'task-b');
    await mkdir(taskA, { recursive: true });
    await mkdir(taskB, { recursive: true });

    await runSay(['--on'], taskA);

    expect((await runSay(['--status'], taskA)).stdout).toBe('on');
    expect((await runSay(['--status'], taskB)).stdout).toBe('off');
    expect(existsSync(join(stateDir, 'task-a'))).toBe(true);
  });

  test('a worktree named <channel>--<repo> shares the switch with its channel', async () => {
    const scratch = join(root, 'scratch', 'fix-backfill');
    const worktree = join(root, 'worktrees', 'fix-backfill--vvs-trading-platform');
    await mkdir(scratch, { recursive: true });
    await mkdir(worktree, { recursive: true });

    await runSay(['--on'], scratch);

    expect((await runSay(['--status'], worktree)).stdout).toBe('on');
  });

  test('--off removes the switch and reports it', async () => {
    const taskA = join(root, 'scratch', 'task-a');
    await mkdir(taskA, { recursive: true });
    await runSay(['--on'], taskA);

    const result = await runSay(['--off'], taskA);

    expect(result.stdout).toBe('always speak: off (task-a)');
    expect((await runSay(['--status'], taskA)).stdout).toBe('off');
  });
});
