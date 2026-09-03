/**
 * The daemon's side of voice-desk (docs/voice-desk-spec.md § Starting a call
 * from Slack): a `!voice` command and a Slack message shortcut, both answering
 * with the link that opens the voice page on this channel. The service itself
 * lives in `voice/`; the daemon only knows its URL.
 */

import type { PlatformFormatter } from '../platform/formatter.js';

/** Top-level `voiceDesk:` block in config.yaml. */
export interface VoiceDeskConfig {
  /** Public URL of the voice page, e.g. https://agents.vvs-capital.com/voice */
  url: string;
}

/** callback_id of the Slack message shortcut ("Talk to this channel"). */
export const VOICE_SHORTCUT_CALLBACK = 'voice_call';

export function resolveVoiceDeskConfig(raw: unknown, fieldPath: string): VoiceDeskConfig {
  const url = (raw as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(`Invalid ${fieldPath}.url: expected the public URL of the voice page`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${fieldPath}.url: not a URL: ${JSON.stringify(url)}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`Invalid ${fieldPath}.url: expected an http(s) URL without query or fragment`);
  }
  return { url: url.replace(/\/+$/, '') };
}

/** The voice page with this channel preselected. */
export function voiceLink(baseUrl: string, channelId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/?channel=${encodeURIComponent(channelId)}`;
}

/** The reply to `!voice` and to the shortcut: the link plus the one thing phones get wrong. */
export function voiceLinkMessage(formatter: PlatformFormatter, baseUrl: string, channelId: string): string {
  const link = voiceLink(baseUrl, channelId);
  return [
    `🎙️ ${formatter.formatBold('Talk to this channel')}: ${formatter.formatLink(link, link)}`,
    formatter.formatItalic('On an iPhone open it in Safari (share icon → Open in Safari); the in-app browser has no microphone. Keep the screen awake during the call.'),
  ].join('\n');
}
