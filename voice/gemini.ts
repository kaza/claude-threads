/**
 * voice-desk: minting one-use ephemeral tokens for the Gemini Live API.
 * Reference: https://ai.google.dev/gemini-api/docs/ephemeral-tokens
 */

import { buildConstraints, type ConstraintOptions } from './prompt.js';

/** The AI Studio id of the 2.5 native-audio model — the one with NON_BLOCKING tools (verified live before use). */
export const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

export interface GeminiDeps {
  apiKey: string;
  fetch: typeof fetch;
  now: () => Date;
  apiUrl?: string;
}

const DEFAULT_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** The token must be used to open a session within this window… */
const NEW_SESSION_WINDOW_MS = 2 * 60 * 1000;
/** …and the session it opens may run this long before Google refuses the token's authority. */
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/** The constrained Live endpoint the browser connects to with the token. */
export const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export interface EphemeralToken {
  /** `auth_tokens/…`, passed as `access_token` on the WebSocket URL. */
  name: string;
  expireTime: string;
}

export async function mintEphemeralToken(deps: GeminiDeps, opts: ConstraintOptions): Promise<EphemeralToken> {
  const now = deps.now().getTime();
  const body = {
    uses: 1,
    expireTime: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
    newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
    liveConnectConstraints: buildConstraints(opts),
  };
  const response = await deps.fetch(`${(deps.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': deps.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch((err: unknown) => `<body unreadable: ${String(err)}>`);
    throw new Error(`Gemini auth_tokens HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as { name?: unknown; expireTime?: unknown };
  if (typeof data.name !== 'string' || !data.name.startsWith('auth_tokens/')) {
    throw new Error('Gemini auth_tokens returned no token name');
  }
  return { name: data.name, expireTime: typeof data.expireTime === 'string' ? data.expireTime : body.expireTime };
}
