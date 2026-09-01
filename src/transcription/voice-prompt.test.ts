import { describe, test, expect } from 'bun:test';
import { SessionManager } from '../session/manager.js';
import { CHAT_PLATFORM_PROMPT } from '../session/lifecycle.js';
import { VOICE_REPLIES_PROMPT } from './voice-prompt.js';
import { validateSpeechConfig } from './index.js';

describe('voice replies in the appended system prompt', () => {
  test('without a speech config the sessions get the plain platform prompt', () => {
    const manager = new SessionManager('/test');

    const prompt = manager.getContext().ops.appendSystemPrompt();

    expect(prompt).toBe(CHAT_PLATFORM_PROMPT);
    expect(prompt).not.toContain('Voice replies');
  });

  test('with a speech config the sessions are told the say rules', () => {
    const manager = new SessionManager('/test');
    manager.setSpeech({ voiceId: 'voice-123' });

    const prompt = manager.getContext().ops.appendSystemPrompt();

    expect(prompt.startsWith(CHAT_PLATFORM_PROMPT)).toBe(true);
    expect(prompt).toContain(VOICE_REPLIES_PROMPT);
    expect(prompt).toContain('say --status');
    expect(prompt).toContain('under 150 words');
  });

  test('clearing the speech config removes the rules again', () => {
    const manager = new SessionManager('/test');
    manager.setSpeech({ voiceId: 'voice-123' });
    manager.setSpeech(undefined);

    expect(manager.getContext().ops.appendSystemPrompt()).toBe(CHAT_PLATFORM_PROMPT);
  });
});

describe('validateSpeechConfig', () => {
  test('passes a config with a voice id through unchanged', () => {
    const config = { voiceId: 'v', model: 'eleven_flash_v2_5' };

    expect(validateSpeechConfig(config)).toBe(config);
  });

  test('rejects a block without a voice id at boot', () => {
    expect(() => validateSpeechConfig({ voiceId: '' })).toThrow(/speech\.voiceId/);
  });
});
