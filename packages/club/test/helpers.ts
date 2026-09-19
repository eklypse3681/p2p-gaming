import type { KeyPair, LobbyTable, PlayerProfile, Signer, TableTemplate } from '@bgf/protocol';
import { createMemoryPair, generateKeyPair, signerFor } from '@bgf/protocol';
import type { ClubServer, TableRegistry } from '../src/index.js';
import {
  ClubClient,
  addOwner,
  createClub,
  issueCertificate,
  mint,
  newClubState,
} from '../src/index.js';
import type { ClubState } from '../src/index.js';

export async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

const keyCache = new Map<string, Promise<KeyPair>>();
export function keysFor(name: string): Promise<KeyPair> {
  let p = keyCache.get(name);
  if (!p) {
    p = generateKeyPair();
    keyCache.set(name, p);
  }
  return p;
}

export async function keyedProfile(
  name: string,
): Promise<{ profile: PlayerProfile; signer: Signer; keys: KeyPair }> {
  const keys = await keysFor(name);
  return {
    profile: { id: `id-${name.toLowerCase()}`, name, publicKey: keys.publicKey },
    signer: signerFor(keys.privateKey),
    keys,
  };
}

/** A throwaway platform key for tests; certificates are verified against its public half. */
export function platformKeys(): Promise<KeyPair> {
  return keysFor('__platform__');
}

export async function issue(clubId: string, amount: number, currency = 'chips'): Promise<string> {
  const keys = await platformKeys();
  return (await issueCertificate({ clubId, currency, amount, privateKey: keys.privateKey })).token;
}

export async function clubFixture(opts: { owner?: string; reserve?: number } = {}) {
  const clubKeys = await keysFor('__club__');
  const identity = createClub({
    name: 'Test Club',
    keys: clubKeys,
    currency: { code: 'chips', name: 'Chips', decimals: 0 },
  });
  const owner = await keyedProfile(opts.owner ?? 'Owner');
  const clubSigner = signerFor(clubKeys.privateKey);
  let state: ClubState = addOwner(newClubState(identity), owner.profile, 1_000);
  const platform = await platformKeys();
  if (opts.reserve) {
    state = (
      await mint(state, await issue(identity.id, opts.reserve), clubSigner, {
        platformPublicKey: platform.publicKey,
        now: 1_001,
      })
    ).state;
  }
  return { identity, clubKeys, clubSigner, owner, state, platformPublicKey: platform.publicKey };
}

/** A fake registry with one open table per template; seats members in order. */
export function fakeRegistry(
  templateFor: (id: string) => TableTemplate | undefined,
): TableRegistry & {
  tables: LobbyTable[];
  sitCalls: unknown[];
  leaveCalls: unknown[];
  cashOut: number;
  fire(): void;
} {
  const listeners = new Set<() => void>();
  const reg = {
    tables: [] as LobbyTable[],
    sitCalls: [] as unknown[],
    leaveCalls: [] as unknown[],
    cashOut: 0,
    fire() {
      for (const l of listeners) l();
    },
    list: () => reg.tables,
    async sit(req: Parameters<TableRegistry['sit']>[0]) {
      reg.sitCalls.push(req);
      let table = reg.tables.find((t) => t.id === req.tableId);
      // `fresh` means "open a new one": a matched group fills a table, so squeezing the first of
      // them into a part-full one would leave the rest with nowhere to sit.
      if (!table && !req.fresh) {
        table = reg.tables.find(
          (t) => t.templateId === req.template.id && t.seats.some((s) => s === null),
        );
      }
      if (!table) {
        table = {
          id: `t-${reg.tables.length + 1}`,
          roomId: req.roomId,
          templateId: req.template.id,
          templateName: req.template.name,
          game: req.template.game,
          code: `CODE${reg.tables.length + 1}`,
          seats: new Array(req.template.seats).fill(null),
          status: 'open',
          stacks: new Array(req.template.seats).fill(0),
        };
        reg.tables.push(table);
      }
      const seat = table.seats.findIndex((s) => s === null);
      if (seat < 0) throw new Error('table full');
      table.seats[seat] = { name: req.member.name, memberId: req.member.id };
      table.stacks[seat] = req.buyIn;
      reg.fire();
      return { tableId: table.id, code: table.code, game: table.game, seat };
    },
    async leave(req: Parameters<TableRegistry['leave']>[0]) {
      reg.leaveCalls.push(req);
      const table = reg.tables.find((t) => t.id === req.tableId);
      if (!table) return { cashOut: 0 };
      const seat = table.seats.findIndex((s) => s?.memberId === req.member.id);
      if (seat < 0) return { cashOut: 0 };
      const cashOut = reg.cashOut || table.stacks[seat]!;
      table.seats[seat] = null;
      table.stacks[seat] = 0;
      reg.fire();
      return { cashOut };
    },
    seated() {
      const out = new Set<string>();
      for (const t of reg.tables) {
        for (const s of t.seats) if (s) out.add(s.memberId);
      }
      return out;
    },
    onChange(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  void templateFor;
  return reg;
}

export function connect(
  server: ClubServer,
  profile: PlayerProfile,
  signer?: Signer,
  invite?: string,
): ClubClient {
  const [serverEnd, clientEnd] = createMemoryPair('club');
  server.accept(serverEnd);
  return new ClubClient({ transport: clientEnd, profile, signer, invite, pingIntervalMs: 0 });
}

export const GAMES = {
  ofc: { minSeats: 2, maxSeats: 3 },
  backgammon: { minSeats: 2, maxSeats: 2 },
};
