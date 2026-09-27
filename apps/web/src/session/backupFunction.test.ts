import { describe, expect, it } from 'vitest';
import { bytesToBase64Url, generateKeyPair, sign } from '@bgf/protocol';
import { onRequestGet, onRequestPut } from '../../functions/api/backup/[id]';
import type { StoredBackup } from './backupFormat';
import { backupBytes } from './backupFormat';

/** The Pages Function against an in-memory stand-in for Workers KV. */
function kv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      const v = data.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

const CRED = 'cred-AAAAAAAAAAAAAAAA';

async function sealed(keys: { publicKey: string; privateKey: string }, ciphertext = 'Y2lwaGVy') {
  const body = {
    credentialId: CRED,
    publicKey: keys.publicKey,
    iv: 'aXZpdml2aXZpdml2',
    ciphertext,
  };
  const signature = bytesToBase64Url(await sign(keys.privateKey, backupBytes(body)));
  return { v: 1 as const, ...body, signature } satisfies StoredBackup;
}

function put(env: { BACKUPS: ReturnType<typeof kv> }, body: unknown, id = CRED) {
  const request = new Request(`https://amongfriends.gg/api/backup/${id}`, {
    method: 'PUT',
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return onRequestPut({ request, env, params: { id } });
}

function get(env: { BACKUPS: ReturnType<typeof kv> }, id = CRED) {
  return onRequestGet({ request: new Request('https://amongfriends.gg/'), env, params: { id } });
}

describe('the backup endpoint', () => {
  it('stores a signed backup and hands it back', async () => {
    const env = { BACKUPS: kv() };
    const keys = await generateKeyPair();
    const backup = await sealed(keys);
    expect((await put(env, backup)).status).toBe(200);
    const res = await get(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(backup);
  });

  it('lets only the same player replace it', async () => {
    const env = { BACKUPS: kv() };
    const alice = await generateKeyPair();
    const mallory = await generateKeyPair();
    await put(env, await sealed(alice));
    expect((await put(env, await sealed(mallory, 'b3RoZXI'))).status).toBe(409);
    expect((await put(env, await sealed(alice, 'bmV3ZXI'))).status).toBe(200);
    expect(((await (await get(env)).json()) as StoredBackup).ciphertext).toBe('bmV3ZXI');
  });

  it('refuses a forged signature, a mismatched id and other sites', async () => {
    const env = { BACKUPS: kv() };
    const keys = await generateKeyPair();
    const backup = await sealed(keys);
    expect((await put(env, { ...backup, ciphertext: 'dGFtcGVyZWQ' })).status).toBe(400);
    expect((await put(env, backup, 'cred-BBBBBBBBBBBBBBBB')).status).toBe(400);
    const foreign = new Request(`https://amongfriends.gg/api/backup/${CRED}`, {
      method: 'PUT',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify(backup),
    });
    expect((await onRequestPut({ request: foreign, env, params: { id: CRED } })).status).toBe(403);
    expect(env.BACKUPS.data.size).toBe(0);
  });

  it('says so when there is nothing stored', async () => {
    expect((await get({ BACKUPS: kv() })).status).toBe(404);
  });
});
