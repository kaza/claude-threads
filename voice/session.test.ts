/**
 * voice-desk: cookies, one-use OAuth nonces, and the JSON store.
 * See docs/voice-desk-spec.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCookieSigner, createStore, parseCookies, serializeCookie } from './session.js';

const SECRET = 'test-secret-that-is-long-enough-for-hmac';

describe('signed cookies', () => {
  test('a value signed with the secret verifies and round-trips', async () => {
    const signer = createCookieSigner(SECRET);

    const signed = await signer.sign('U123');

    expect(await signer.verify(signed)).toBe('U123');
  });

  test('a tampered value is rejected', async () => {
    const signer = createCookieSigner(SECRET);
    const signed = await signer.sign('U123');
    const signature = signed.slice(signed.lastIndexOf('.') + 1);
    const forgedValue = `${Buffer.from('U999').toString('base64url')}.${signature}`;

    expect(await signer.verify(forgedValue)).toBeNull();
    expect(await signer.verify(`${signed}x`)).toBeNull();
    expect(await signer.verify('garbage')).toBeNull();
  });

  test('a value signed with another secret is rejected', async () => {
    const signed = await createCookieSigner('other-secret-also-long-enough').sign('U123');

    expect(await createCookieSigner(SECRET).verify(signed)).toBeNull();
  });

  test('the session cookie carries the hardening attributes and the base path', () => {
    const header = serializeCookie('__Secure-voice', 'abc', { path: '/voice', maxAgeSeconds: 2592000 });

    expect(header).toBe('__Secure-voice=abc; Path=/voice; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax');
  });

  test('an empty base path scopes the cookie to the root', () => {
    expect(serializeCookie('__Secure-voice', 'abc', { path: '', maxAgeSeconds: 10 })).toContain('Path=/;');
  });

  test('an expired cookie header clears the value', () => {
    expect(serializeCookie('__Secure-voice', '', { path: '/voice', maxAgeSeconds: 0 })).toContain('Max-Age=0');
  });

  test('parseCookies reads a Cookie header', () => {
    expect(parseCookies('a=1; __Secure-voice=x.y; b=2')).toEqual({ a: '1', '__Secure-voice': 'x.y', b: '2' });
    expect(parseCookies(null)).toEqual({});
  });
});

describe('the JSON store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('starts empty, persists users and calls, and reloads them', async () => {
    const path = join(dir, 'state.json');
    const store = await createStore(path);
    await store.update((s) => {
      s.users['U1'] = { userId: 'U1', name: 'Almir', token: 'xoxp-1' };
    });

    const reloaded = await createStore(path);

    expect(reloaded.snapshot().users['U1']).toEqual({ userId: 'U1', name: 'Almir', token: 'xoxp-1' });
    expect(reloaded.snapshot().calls).toEqual({});
  });

  test('writes the file with owner-only permissions', async () => {
    const path = join(dir, 'state.json');
    const store = await createStore(path);
    await store.update((s) => { s.users['U1'] = { userId: 'U1', name: 'A', token: 't' }; });

    const { mode } = await import('fs').then((fs) => fs.statSync(path));

    expect(mode & 0o777).toBe(0o600);
  });

  test('two concurrent updates both land, in order', async () => {
    const path = join(dir, 'state.json');
    const store = await createStore(path);

    await Promise.all([
      store.update((s) => { s.users['U1'] = { userId: 'U1', name: 'A', token: 't1' }; }),
      store.update((s) => { s.users['U2'] = { userId: 'U2', name: 'B', token: 't2' }; }),
    ]);

    const reloaded = await createStore(path);
    expect(Object.keys(reloaded.snapshot().users).sort()).toEqual(['U1', 'U2']);
  });

  test('a failing update leaves the file as it was', async () => {
    const path = join(dir, 'state.json');
    const store = await createStore(path);
    await store.update((s) => { s.users['U1'] = { userId: 'U1', name: 'A', token: 't1' }; });

    await expect(store.update(() => { throw new Error('boom'); })).rejects.toThrow('boom');

    expect(JSON.parse(await readFile(path, 'utf8')).users['U1'].token).toBe('t1');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test('refuses a symlinked store path', async () => {
    const real = join(dir, 'elsewhere.json');
    await writeFile(real, '{}');
    const link = join(dir, 'state.json');
    await symlink(real, link);

    await expect(createStore(link)).rejects.toThrow(/symlink/);
  });
});
