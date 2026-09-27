import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@bgf/protocol';
import { createMemoryPair, generateKeyPair, signerFor } from '@bgf/protocol';
import { issueGrant, issueRevocation, openRevocation } from '@bgf/wallet';
import type { GameDefinition } from '../src/index.js';
import { TableClient, TableServer, setRevocationLookup } from '../src/index.js';

/**
 * A player's seat is bound to their own key. One of their devices, holding only its own key and
 * a grant from the player's, must be able to take that seat; nothing else may.
 */

interface S {
  n: number;
}
type A = { type: 'inc' };
const toy: GameDefinition<S, A, A> = {
  id: 'toy',
  minSeats: 2,
  maxSeats: 2,
  init: () => ({ n: 0 }),
  validateCommand: (raw) => ((raw as A)?.type === 'inc' ? (raw as A) : null),
  command: () => ({ type: 'inc' }),
  reduce: (s) => ({ n: s.n + 1 }),
  view: (s) => s,
};

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

async function setup() {
  const host = await generateKeyPair();
  const player = await generateKeyPair();
  const server = new TableServer<S, A, A>({
    def: toy,
    config: {},
    code: 'DLG001',
    host: { id: 'host', name: 'Host', publicKey: host.publicKey },
    hostSeat: null,
    seats: 2,
  });
  const profile: PlayerProfile = { id: 'alice', name: 'Alice', publicKey: player.publicKey };
  server.reserveSeat(0, { profileId: 'alice', publicKey: player.publicKey });
  return { server, player, profile };
}

function connect(
  server: TableServer<S, A, A>,
  profile: PlayerProfile,
  signer: ReturnType<typeof signerFor>,
  grant?: string,
) {
  const [se, ce] = createMemoryPair('dlg');
  server.accept(se);
  return new TableClient<S>({ transport: ce, profile, signer, grant, pingIntervalMs: 0 });
}

describe('a seat taken by one of the player’s devices', () => {
  it('admits a device presenting a current grant from the player’s key', async () => {
    const { server, player, profile } = await setup();
    const phone = await generateKeyPair();
    const grant = await issueGrant(player, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
    });
    const client = connect(server, profile, signerFor(phone.privateKey), grant);
    await settle();
    expect(client.getState().status).toBe('joined');
    expect(client.getState().seat).toBe(0);
  });

  it('admits a device whose signer carries the grant, as the app builds it', async () => {
    const { server, player, profile } = await setup();
    const phone = await generateKeyPair();
    const grant = await issueGrant(player, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
    });
    // No separate `grant` option: the signer itself carries it (see ProfileProvider.signerOf).
    const client = connect(server, profile, signerFor(phone.privateKey, grant));
    await settle();
    expect(client.getState().status).toBe('joined');
  });

  it('refuses a device without a grant', async () => {
    const { server, profile } = await setup();
    const phone = await generateKeyPair();
    const client = connect(server, profile, signerFor(phone.privateKey));
    await settle();
    expect(client.getState().rejectReason).toBe('unauthorized');
  });

  it('refuses a grant that does not allow sitting down', async () => {
    const { server, player, profile } = await setup();
    const phone = await generateKeyPair();
    const grant = await issueGrant(player, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['sync'],
    });
    const client = connect(server, profile, signerFor(phone.privateKey), grant);
    await settle();
    expect(client.getState().rejectReason).toBe('unauthorized');
  });

  it('refuses a grant from somebody else’s key', async () => {
    const { server, profile } = await setup();
    const mallory = await generateKeyPair();
    const phone = await generateKeyPair();
    const grant = await issueGrant(mallory, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
    });
    const client = connect(server, profile, signerFor(phone.privateKey), grant);
    await settle();
    expect(client.getState().rejectReason).toBe('unauthorized');
  });

  it('still admits the player’s own key with no grant', async () => {
    const { server, player, profile } = await setup();
    const client = connect(server, profile, signerFor(player.privateKey));
    await settle();
    expect(client.getState().status).toBe('joined');
  });
});

describe('a device the player signed out', () => {
  it('is refused once the table can see the revocation, and the player still gets in', async () => {
    const { server, player, profile } = await setup();
    const phone = await generateKeyPair();
    const grant = await issueGrant(player, {
      device: phone.publicKey,
      serial: 3,
      label: 'lost phone',
      scopes: ['seat'],
    });
    const revocation = await openRevocation(
      await issueRevocation(player, { serials: [3] }),
      player.publicKey,
    );
    setRevocationLookup(async (key) => (key === player.publicKey ? revocation : null));
    try {
      const lost = connect(server, profile, signerFor(phone.privateKey, grant));
      await settle();
      expect(lost.getState().rejectReason).toBe('unauthorized');
      const owner = connect(server, profile, signerFor(player.privateKey));
      await settle();
      expect(owner.getState().status).toBe('joined');
    } finally {
      setRevocationLookup(null);
    }
  });

  it('is still admitted when the table cannot reach the list', async () => {
    const { server, player, profile } = await setup();
    const phone = await generateKeyPair();
    const grant = await issueGrant(player, {
      device: phone.publicKey,
      serial: 1,
      label: 'phone',
      scopes: ['seat'],
    });
    setRevocationLookup(async () => {
      throw new Error('offline');
    });
    try {
      const client = connect(server, profile, signerFor(phone.privateKey, grant));
      await settle();
      expect(client.getState().status).toBe('joined');
    } finally {
      setRevocationLookup(null);
    }
  });
});
