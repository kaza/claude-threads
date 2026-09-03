import { describe, it, expect } from 'bun:test';
import { resolveVoiceDeskConfig, voiceLink, voiceLinkMessage, VOICE_SHORTCUT_CALLBACK } from './index.js';
import { parseCommand } from '../commands/parser.js';
import { COMMAND_REGISTRY } from '../commands/registry.js';

const formatter = {
  formatBold: (t: string) => `*${t}*`,
  formatItalic: (t: string) => `_${t}_`,
  formatLink: (text: string, url: string) => `<${url}|${text}>`,
} as never;

describe('voice-desk config', () => {
  it('accepts a plain http(s) URL and trims a trailing slash', () => {
    expect(resolveVoiceDeskConfig({ url: 'https://agents.vvs-capital.com/voice/' }, 'voiceDesk')).toEqual({ url: 'https://agents.vvs-capital.com/voice' });
  });

  it('rejects a missing, non-http, or decorated URL, naming the field', () => {
    expect(() => resolveVoiceDeskConfig({}, 'voiceDesk')).toThrow('voiceDesk.url');
    expect(() => resolveVoiceDeskConfig({ url: 'agents.vvs-capital.com/voice' }, 'voiceDesk')).toThrow('voiceDesk.url');
    expect(() => resolveVoiceDeskConfig({ url: 'https://agents.vvs-capital.com/voice?x=1' }, 'voiceDesk')).toThrow('without query');
  });
});

describe('voice link', () => {
  it('opens the page with the channel preselected', () => {
    expect(voiceLink('https://agents.vvs-capital.com/voice', 'C0BU9JM6ASW')).toBe('https://agents.vvs-capital.com/voice/?channel=C0BU9JM6ASW');
  });

  it('the message carries the link and the iPhone note', () => {
    const text = voiceLinkMessage(formatter, 'https://x/voice', 'C1');
    expect(text).toContain('<https://x/voice/?channel=C1|https://x/voice/?channel=C1>');
    expect(text).toContain('Safari');
  });
});

describe('!voice command', () => {
  it('parses', () => {
    expect(parseCommand('!voice')).toMatchObject({ command: 'voice' });
  });

  it('is listed for users in the registry', () => {
    const entry = COMMAND_REGISTRY.find((c) => c.command === 'voice');
    expect(entry?.audience).toBe('user');
  });

  it('the shortcut callback id is stable', () => {
    expect(VOICE_SHORTCUT_CALLBACK).toBe('voice_call');
  });
});
