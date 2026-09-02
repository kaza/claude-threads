/**
 * voice-desk: signed cookies, one-use OAuth nonces and the on-disk store.
 * See docs/voice-desk-spec.md § Sign in with Slack.
 *
 * Everything here is dependency-free: WebCrypto for HMAC, fs for the store.
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname } from 'path';

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface CookieSigner {
  /** `value.signature`, base64url both sides. */
  sign(value: string): Promise<string>;
  /** The value, or null when the signature does not verify. */
  verify(signed: string | undefined | null): Promise<string | null>;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(new Uint8Array(bytes)).toString('base64url');
}

export function createCookieSigner(secret: string): CookieSigner {
  const keyPromise = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  async function mac(value: string): Promise<string> {
    const key = await keyPromise;
    return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
  }

  return {
    async sign(value) {
      return `${b64url(enc.encode(value))}.${await mac(value)}`;
    },
    async verify(signed) {
      if (!signed) return null;
      const dot = signed.lastIndexOf('.');
      if (dot <= 0) return null;
      const value = Buffer.from(signed.slice(0, dot), 'base64url').toString('utf8');
      const expected = await mac(value);
      const given = signed.slice(dot + 1);
      if (expected.length !== given.length) return null;
      // Constant-time compare on equal lengths.
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
      return diff === 0 ? value : null;
    },
  };
}

export interface CookieOptions {
  /** External path prefix (`/voice`) or '' for the root. Never a security boundary — see the spec. */
  path: string;
  maxAgeSeconds: number;
}

/** A hardened Set-Cookie value: HttpOnly, Secure, SameSite=Lax, explicit Path. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const path = opts.path === '' ? '/' : opts.path;
  return `${name}=${value}; Path=${path}; Max-Age=${opts.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoredUser {
  userId: string;
  name: string;
  /** Slack user token (xoxp). Never leaves the box. */
  token: string;
  /**
   * Random per-login generation. The cookie carries it; a new login rotates
   * it, so a copied cookie dies with the login that minted it (review
   * finding 9) and logout is durable.
   */
  session?: string;
}

export interface StoredCall {
  callId: string;
  userId: string;
  channel: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface StoredCard {
  channel: string;
  /** Slack call id (`R…`) from calls.add. */
  slackCallId: string;
  /** The user whose token created it; also used to end it. */
  userId: string;
  createdAt: number;
}

export interface StoreState {
  users: Record<string, StoredUser>;
  calls: Record<string, StoredCall>;
  cards: Record<string, StoredCard>;
}

export interface Store {
  snapshot(): StoreState;
  /** Serialised read-modify-write; persisted atomically. A throwing mutator changes nothing. */
  update(mutate: (state: StoreState) => void): Promise<void>;
}

function emptyState(): StoreState {
  return { users: {}, calls: {}, cards: {} };
}

function clone(state: StoreState): StoreState {
  return JSON.parse(JSON.stringify(state)) as StoreState;
}

/**
 * A single JSON file, 0600 in a 0700 directory, written temp-file + rename so
 * a crash mid-write leaves the previous file intact. One in-process writer
 * queue: updates never interleave.
 */
export async function createStore(path: string): Promise<Store> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let state = emptyState();
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`voice-desk store must not be a symlink: ${path}`);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Record<keyof StoreState, unknown>>;
    const section = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, never>) : {});
    state = { users: section(parsed.users), calls: section(parsed.calls), cards: section(parsed.cards) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let queue: Promise<void> = Promise.resolve();
  const tmp = `${path}.tmp`;

  async function persist(next: StoreState): Promise<void> {
    await writeFile(tmp, JSON.stringify(next, null, 1), { mode: 0o600, flag: 'w' });
    await rename(tmp, path);
  }

  return {
    snapshot: () => clone(state),
    update(mutate) {
      const run = queue.then(async () => {
        const next = clone(state);
        try {
          mutate(next);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
        await persist(next);
        state = next;
      });
      // Keep the queue alive past a failure so later updates still run.
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
