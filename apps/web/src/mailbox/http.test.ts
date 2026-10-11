import { describe, expect, it } from 'vitest';
import { handleMailbox } from './http';

const URL_ = 'https://amongfriends.gg/api/mailbox';
const db = {} as never;

describe('the mailbox over HTTP', () => {
  it('says whether it is set up, and gives the push key only when it can push', async () => {
    const off = await handleMailbox('status', new Request(`${URL_}/status`), {});
    expect(await off.json()).toEqual({ available: false, vapidKey: null });
    const on = await handleMailbox('status', new Request(`${URL_}/status`), {
      MAILBOX: db,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
    });
    expect(await on.json()).toEqual({ available: true, vapidKey: 'pub' });
  });

  it('is unavailable until its database is bound', async () => {
    const r = await handleMailbox('inbox', new Request(`${URL_}/inbox`), {});
    expect(r.status).toBe(503);
  });

  it('refuses writes from other sites and requests without a token', async () => {
    const env = { MAILBOX: db };
    const foreign = new Request(`${URL_}/send`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Authorization: 'Bearer x' },
      body: '{}',
    });
    expect((await handleMailbox('send', foreign, env)).status).toBe(403);
    const anon = new Request(`${URL_}/inbox`);
    const res = await handleMailbox('inbox', anon, env, { db: fakeDb(), now: () => 0 });
    expect(res.status).toBe(401);
  });
});

function fakeDb() {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  };
  return { prepare: () => stmt, exec: async () => {} } as never;
}
