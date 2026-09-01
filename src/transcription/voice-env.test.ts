import { describe, test, expect } from 'bun:test';
import { buildClaudeChildEnv } from '../claude/cli.js';
import { CONFIG_PATH } from '../config/index.js';
import { CONFIG_PATH_ENV, SPEAK_DIR_ENV, SPEAK_KEY_ENV, speakStateDir } from './voice-prompt.js';

describe('the session identity the daemon exports for say', () => {
  test('a spawn with a sessionKey carries the key, the marker dir and the config path', () => {
    const env = buildClaudeChildEnv({ PATH: '/usr/bin' }, undefined, { sessionKey: 'slack-vvs:dcm:slack-vvs' });

    expect(env[SPEAK_KEY_ENV]).toBe('slack-vvs_dcm_slack-vvs');
    expect(env[SPEAK_DIR_ENV]).toBe(speakStateDir());
    expect(env[CONFIG_PATH_ENV]).toBe(CONFIG_PATH);
  });

  test('a pooled account with its own HOME still gets the daemon\'s paths', () => {
    const env = buildClaudeChildEnv({ PATH: '/usr/bin' }, { id: 'pool-1', home: '/srv/accounts/one' } as any, { sessionKey: 'mm:thread-9' });

    expect(env.HOME).toBe('/srv/accounts/one');
    expect(env[SPEAK_DIR_ENV]).toBe(speakStateDir());
    expect(env[SPEAK_DIR_ENV]!.startsWith('/srv/accounts/one')).toBe(false);
    expect(env[CONFIG_PATH_ENV]).toBe(CONFIG_PATH);
  });

  test('without a sessionKey nothing voice-related is exported', () => {
    const env = buildClaudeChildEnv({ PATH: '/usr/bin' });

    expect(env[SPEAK_KEY_ENV]).toBeUndefined();
    expect(env[SPEAK_DIR_ENV]).toBeUndefined();
    expect(env[CONFIG_PATH_ENV]).toBeUndefined();
  });
});
