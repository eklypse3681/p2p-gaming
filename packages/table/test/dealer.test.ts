import { describe, expect, it } from 'vitest';
import type { PlayerProfile, TableSnapshot } from '@bgf/protocol';
import { DEALER_SEAT, createMemoryPair, generateKeyPair, signerFor } from '@bgf/protocol';
import type { GameDefinition } from '../src/index.js';
import { CommandError, TableClient, TableServer, seededRng, verifySnapshot } from '../src/index.js';

/** Toy hidden-information game: the dealer may re-draw the secret; only seats may guess. */
interface ToyState {
  secret: number;
  guesses: { seat: number; value: number; hit: boolean }[];
}
type ToyAction =
  { type: 'deal'; secret: number } | { type: 'guess'; seat: number; value: number; hit: boolean };
type ToyCommand = { type: 'guess'; value: number } | { type: 'redeal' };
interface ToyView {
  secret: number | null;
  guesses: ToyState['guesses'];
}

const toy: GameDefinition<ToyState, ToyAction, ToyCommand, ToyView> = {
  id: 'toy',
  minSeats: 2,
  maxSeats: 3,
  hiddenInformation: true,
  init: (_c, ctx) => ({ secret: ctx.rng.int(10) + 1, guesses: [] }),
  validateCommand(raw) {
    const r = raw as { type?: unknown; value?: unknown };
    if (r?.type === 'redeal') return { type: 'redeal' };
    if (r?.type === 'guess' && Number.isInteger(r.value))
      return { type: 'guess', value: r.value as number };
    return null;
  },
  command(state, seat, cmd, ctx) {
    if (cmd.type === 'redeal') return { type: 'deal', secret: ctx.rng.int(10) + 1 };
    if (seat < 0) throw new CommandError('not-a-player', 'guessing needs a seat');
    return { type: 'guess', seat, value: cmd.value, hit: cmd.value === state.secret };
  },
  reduce(state, action) {
    if (action.type === 'deal') return { ...state, secret: action.secret };
    return { ...state, guesses: [...state.guesses, action] };
  },
  view: (state) => ({ secret: null, guesses: state.guesses }),
  viewAction: (action) => (action.type === 'deal' ? { type: 'deal', secret: -1 } : action),
  dealerCommands: ['redeal'],
};

const P = (id: string): PlayerProfile => ({ id, name: id.toUpperCase() });
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

type Server = TableServer<ToyState, ToyAction, ToyCommand, ToyView>;
type Client = TableClient<ToyState, ToyAction, unknown, ToyView>;

function connect(server: Server, profile: PlayerProfile, resume?: TableSnapshot): Client {
  const [serverEnd, clientEnd] = createMemoryPair('dealer');
  server.accept(serverEnd);
  return new TableClient({
    transport: clientEnd,
    profile,
    pingIntervalMs: 0,
    resumeSnapshot: resume as never,
  });
}

function local(server: Server, profile: PlayerProfile): Client {
  return new TableClient({ transport: server.connectLocal(), profile, pingIntervalMs: 0 });
}

async function dealerTable() {
  const server: Server = new TableServer({
    def: toy,
    code: 'DEAL',
    host: P('dealer'),
    hostSeat: null,
    seats: 3,
    rng: seededRng(3),
    now: () => 7,
  });
  const dealer = local(server, P('dealer'));
  const a = connect(server, P('a'));
  const b = connect(server, P('b'));
  const c = connect(server, P('c'));
  await flush();
  return { server, dealer, a, b, c };
}

describe('dealer mode (a non-playing host)', () => {
  it('welcomes the dealer with no seat, seats every guest, and shows the dealer everything', async () => {
    const { server, dealer, a, b, c } = await dealerTable();
    expect(server.dealerMode).toBe(true);
    expect(server.getSnapshot().hostSeat).toBeNull();
    expect(server.getSnapshot().dealer).toEqual(P('dealer'));
    expect(server.getSnapshot().seats.map((s) => s?.id)).toEqual(['a', 'b', 'c']);
    expect(dealer.getState()).toMatchObject({ status: 'joined', seat: null, role: 'dealer' });
    expect(dealer.getState().snapshot!.state.secret).toBe(server.getSnapshot().state.secret);
    expect(dealer.getState().snapshot!.view).toBeUndefined();
    expect([a, b, c].map((x) => x.getState().seat)).toEqual([0, 1, 2]);
    expect(a.getState().role).toBe('seat');
    expect(a.getState().snapshot!.state.secret).toBeNull();
    expect(a.getState().snapshot!.hostSeat).toBeNull();
    expect(a.getState().dealer).toEqual({ profile: P('dealer'), connected: true });
    expect(dealer.getState().presence).toEqual([true, true, true]);
    // A fourth player is turned away: the dealer holds no seat, all three are taken.
    const d = connect(server, P('d'));
    await flush();
    expect(d.getState().rejectReason).toBe('full');
    expect(server.dealerConnected()).toBe(true);
    server.close();
  });

  it('lets the dealer send only its commands, chat and leave; seats play as usual', async () => {
    const { server, dealer, a, b } = await dealerTable();
    dealer.send({ type: 'redeal' });
    await flush();
    expect(server.getSnapshot().actions).toEqual([{ type: 'deal', secret: expect.any(Number) }]);
    expect(a.getState().lastAction).toMatchObject({
      action: { type: 'deal', secret: -1 },
      by: DEALER_SEAT,
    });
    expect(dealer.getState().lastAction!.action).toEqual(server.getSnapshot().actions[0]);

    dealer.send({ type: 'guess', value: 3 });
    dealer.sendPreview({ any: 1 });
    await flush();
    expect(dealer.getState().error).toMatchObject({ code: 'not-seated' });
    expect(server.getSnapshot().actions).toHaveLength(1);

    a.send({ type: 'guess', value: server.getSnapshot().state.secret });
    await flush();
    expect(b.getState().lastAction).toMatchObject({
      action: { type: 'guess', seat: 0, hit: true },
      by: 0,
    });
    expect(dealer.getState().lastAction).toMatchObject({ by: 0 });

    dealer.sendChat('cards are in the air');
    await flush();
    expect(a.getState().chat).toEqual([{ seat: DEALER_SEAT, text: 'cards are in the air', at: 7 }]);
    // Seat previews reach the dealer too (it watches the table).
    a.sendPreview({ thinking: true });
    await flush();
    expect(dealer.getState().previews).toEqual({ 0: { thinking: true } });
    server.close();
  });

  it('announces dealer presence to seats on the first device and the last leaving', async () => {
    const { server, dealer, a } = await dealerTable();
    const seen: boolean[] = [];
    a.subscribe(() => seen.push(a.getState().dealer!.connected));
    const dealer2 = local(server, P('dealer'));
    await flush();
    expect(dealer2.getState()).toMatchObject({ status: 'joined', role: 'dealer', seat: null });
    expect(a.getState().dealer!.connected).toBe(true);
    dealer.close();
    await flush();
    expect(a.getState().dealer!.connected).toBe(true); // one dealer device is still here
    dealer2.close();
    await flush();
    expect(a.getState().dealer!.connected).toBe(false);
    expect(seen.filter((x) => !x)).toHaveLength(1);
    expect(server.dealerConnected()).toBe(false);
    server.close();
  });

  it('only a dealer copy can re-host; a guest view cannot, and a guest offering one is refused', async () => {
    const { server, dealer, a } = await dealerTable();
    dealer.send({ type: 'redeal' });
    await flush();
    const dealerCopy = dealer.getState().snapshot! as TableSnapshot<ToyState, ToyAction>;
    const guestCopy = a.getState().snapshot!;
    server.close();

    expect(() => verifySnapshot(toy, guestCopy as never)).toThrow(/view/);
    const again: Server = new TableServer({
      def: toy,
      code: 'DEAL',
      host: P('dealer'),
      snapshot: dealerCopy,
    });
    expect(again.dealerMode).toBe(true);
    expect(again.getSnapshot().dealer?.id).toBe('dealer');
    const d2 = local(again, P('dealer'));
    const a2 = connect(again, P('a'), { ...guestCopy, seq: guestCopy.seq + 5 });
    await flush();
    expect(d2.getState().role).toBe('dealer');
    expect(a2.getState()).toMatchObject({ status: 'joined', seat: 0 });
    expect(a2.getState().error).toMatchObject({ code: 'host-only-resume' });
    expect(again.getSnapshot().seq).toBe(dealerCopy.seq);
    again.close();
  });

  it('binds the dealer to its key like a seat', async () => {
    const keys = await generateKeyPair();
    const other = await generateKeyPair();
    const dealerProfile: PlayerProfile = { ...P('dealer'), publicKey: keys.publicKey };
    const server: Server = new TableServer({
      def: toy,
      code: 'KEY',
      host: dealerProfile,
      hostSeat: null,
      seats: 2,
      rng: seededRng(1),
    });
    const dealer = new TableClient({
      transport: server.connectLocal(),
      profile: dealerProfile,
      signer: signerFor(keys.privateKey),
      pingIntervalMs: 0,
    });
    await flush(12);
    expect(dealer.getState().role).toBe('dealer');
    expect(server.getSnapshot().dealer?.publicKey).toBe(keys.publicKey);
    const impostor = new TableClient({
      transport: server.connectLocal(),
      profile: { ...P('dealer'), publicKey: other.publicKey },
      signer: signerFor(other.privateKey),
      pingIntervalMs: 0,
    });
    await flush(12);
    expect(impostor.getState().rejectReason).toBe('unauthorized');
    server.close();
  });
});

describe('simultaneous hellos', () => {
  it('three keyed players saying hello at the same instant all get distinct seats', async () => {
    const dk = await generateKeyPair();
    const server = new TableServer({
      def: toy,
      config: {},
      code: 'RACE01',
      host: { id: 'dealer', name: 'House', publicKey: dk.publicKey },
      hostSeat: null,
      seats: 3,
    });
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const k = await generateKeyPair();
      const [se, ce] = createMemoryPair(`race${i}`);
      server.accept(se);
      clients.push(
        new TableClient({
          transport: ce,
          profile: { id: `p${i}`, name: `P${i}`, publicKey: k.publicKey },
          signer: signerFor(k.privateKey),
          pingIntervalMs: 0,
        }),
      );
    }
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
    const seats = clients.map((c) => c.getState().seat);
    expect(clients.map((c) => c.getState().status)).toEqual(['joined', 'joined', 'joined']);
    expect([...seats].sort()).toEqual([0, 1, 2]);
    for (const c of clients) c.close();
    server.close();
  });
});
