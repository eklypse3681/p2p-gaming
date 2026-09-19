import type {
  LedgerEntry,
  LedgerKind,
  MemberStatement,
  PlatformCertificate,
  Signer,
  StatementLine,
  TableStakes,
} from '@bgf/protocol';
import { base64UrlToBytes, bytesToBase64Url, verify } from '@bgf/protocol';
import { utf8Bytes } from '@bgf/table';
import {
  PLATFORM_MIN_RAKE_BPS,
  PLATFORM_PUBLIC_KEY,
  decodeCertificate,
  verifyCertificate,
} from '../platform.js';
import { canonicalJson, hashText } from './canonical.js';
import { ClubError } from './identity.js';
import { findMember, isAdmin } from './members.js';
import type { ClubState } from './state.js';

export const HOUSE = 'house';
export const GENESIS_HASH = hashText('p2p-gaming club ledger v1');

/** A player's stack at a table lives in `table:<tableId>:<memberId>`; the pooled form is legacy. */
export function tableAccount(tableId: string, memberId?: string): string {
  return memberId ? `table:${tableId}:${memberId}` : `table:${tableId}`;
}

export function isTableAccount(account: string): boolean {
  return account.startsWith('table:');
}

export function isTournamentAccount(account: string): boolean {
  return account.startsWith('tournament:');
}

function isMemberAccount(account: string): boolean {
  return account !== HOUSE && !isTableAccount(account) && !isTournamentAccount(account);
}

export interface LedgerDraft {
  kind: LedgerKind;
  lines: Array<{ account: string; amount: number }>;
  ref?: LedgerEntry['ref'];
  at?: number;
}

/** What the hash covers: everything but the hash and signature. */
export function entryHash(
  prevHash: string,
  body: Pick<LedgerEntry, 'seq' | 'at' | 'kind' | 'lines' | 'ref'>,
): string {
  const canonical = canonicalJson({
    seq: body.seq,
    at: body.at,
    kind: body.kind,
    lines: body.lines,
    ref: body.ref ?? null,
  });
  return hashText(`${prevHash}${canonical}`);
}

export function balances(state: ClubState): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of state.ledger) {
    for (const line of entry.lines) {
      out.set(line.account, (out.get(line.account) ?? 0) + line.amount);
    }
  }
  return out;
}

export function balanceOf(state: ClubState, account: string): number {
  let total = 0;
  for (const entry of state.ledger) {
    for (const line of entry.lines) if (line.account === account) total += line.amount;
  }
  return total;
}

export function houseBalance(state: ClubState): number {
  return balanceOf(state, HOUSE);
}

/** Everything the house holds: chips minted but not yet granted, redeemed or burned. */
export function reserve(state: ClubState): number {
  return balanceOf(state, HOUSE);
}

/** Chips held by members, table stacks and tournament pools. */
export function circulation(state: ClubState): number {
  let total = 0;
  for (const [account, amount] of balances(state)) if (account !== HOUSE) total += amount;
  return total;
}

function lineSum(entry: LedgerEntry): number {
  return entry.lines.reduce((a, l) => a + l.amount, 0);
}

export function minted(state: ClubState): number {
  return state.ledger.filter((e) => e.kind === 'mint').reduce((a, e) => a + lineSum(e), 0);
}

export function burned(state: ClubState): number {
  return -state.ledger.filter((e) => e.kind === 'burn').reduce((a, e) => a + lineSum(e), 0);
}

export function seatStack(state: ClubState, tableId: string, memberId: string): number {
  return balanceOf(state, tableAccount(tableId, memberId));
}

export interface AppendOptions {
  /** Buy-in bounds to enforce for `buy-in` entries (from the table template). */
  buyInBounds?: { min: number; max: number };
  now?: number;
}

function validateDraft(state: ClubState, draft: LedgerDraft, opts: AppendOptions): void {
  if (!Array.isArray(draft.lines) || draft.lines.length === 0) {
    throw new ClubError('bad-entry', 'an entry needs at least one line');
  }
  let sum = 0;
  for (const line of draft.lines) {
    if (typeof line.account !== 'string' || !line.account) {
      throw new ClubError('bad-entry', 'every line needs an account');
    }
    if (!Number.isInteger(line.amount)) throw new ClubError('bad-entry', 'amounts are integers');
    sum += line.amount;
  }
  const kind = draft.kind;
  if (kind === 'burn') {
    if (draft.lines.some((l) => l.amount >= 0 || l.account === HOUSE)) {
      throw new ClubError('bad-entry', 'a burn only takes chips out of circulating accounts');
    }
  } else if (kind === 'mint') {
    const only = draft.lines[0]!;
    if (draft.lines.length !== 1 || only.account !== HOUSE || only.amount <= 0) {
      throw new ClubError('bad-entry', 'a mint credits the house exactly once');
    }
    if (!draft.ref?.certificate) {
      throw new ClubError('bad-entry', 'a mint needs its platform certificate');
    }
  } else if (sum !== 0) {
    throw new ClubError('unbalanced', 'entry lines must sum to zero');
  }
  // Only the platform (mint), redemptions and fees may ever credit the house.
  if (kind !== 'mint' && kind !== 'redeem' && kind !== 'fee') {
    if (draft.lines.some((l) => l.account === HOUSE && l.amount > 0)) {
      throw new ClubError('bad-entry', `${kind} entries may not credit the house`);
    }
  }

  const memberLines = draft.lines.filter((l) => isMemberAccount(l.account));
  for (const line of memberLines) {
    const member = findMember(state, line.account);
    if (!member) throw new ClubError('no-member', `unknown member ${line.account}`);
    if (member.status !== 'active') {
      throw new ClubError('inactive-member', `${member.name} is not an active member`);
    }
  }
  const current = balances(state);
  const after = (account: string): number => {
    const delta = draft.lines
      .filter((l) => l.account === account)
      .reduce((a, l) => a + l.amount, 0);
    return (current.get(account) ?? 0) + delta;
  };

  if (kind === 'adjust') {
    const by = draft.ref?.by;
    if (!by || !isAdmin(findMember(state, by))) {
      throw new ClubError('forbidden', 'adjustments need an admin in ref.by');
    }
  } else {
    for (const line of memberLines) {
      if (after(line.account) < 0) {
        throw new ClubError('insufficient', `${line.account} does not have enough chips`);
      }
    }
  }
  for (const line of draft.lines) {
    const pooled = isTableAccount(line.account) || isTournamentAccount(line.account);
    if (pooled && after(line.account) < 0) {
      throw new ClubError('insufficient', `${line.account} cannot go below zero`);
    }
  }
  // The reserve is what the platform sold: grants and adjustments cannot overdraw it.
  if (after(HOUSE) < 0) {
    throw new ClubError('reserve', 'the club reserve is too low; mint more chips');
  }

  switch (kind) {
    case 'grant':
    case 'redeem':
    case 'fee':
      if (!draft.lines.some((l) => l.account === HOUSE)) {
        throw new ClubError('bad-entry', `${kind} entries involve the house`);
      }
      break;
    case 'buy-in': {
      const toTable = draft.lines.filter((l) => isTableAccount(l.account) && l.amount > 0);
      if (toTable.length !== 1 || memberLines.length !== 1) {
        throw new ClubError('bad-entry', 'a buy-in moves chips from one member to one table');
      }
      const amount = toTable[0]!.amount;
      const b = opts.buyInBounds;
      if (b && (amount < b.min || amount > b.max)) {
        throw new ClubError('bad-buy-in', `buy-in must be between ${b.min} and ${b.max}`);
      }
      break;
    }
    case 'cash-out':
      if (!draft.lines.some((l) => isTableAccount(l.account) && l.amount < 0)) {
        throw new ClubError('bad-entry', 'a cash-out moves chips off a table');
      }
      break;
    case 'transfer':
      if (memberLines.length !== draft.lines.length || draft.lines.length !== 2) {
        throw new ClubError('bad-entry', 'a transfer is between exactly two members');
      }
      break;
    case 'result':
    case 'adjust':
    case 'mint':
    case 'burn':
      break;
  }
}

/** Append a validated, hashed and signed entry. Returns the new state and the entry. */
export async function appendEntry(
  state: ClubState,
  draft: LedgerDraft,
  signer: Signer,
  opts: AppendOptions = {},
): Promise<{ state: ClubState; entry: LedgerEntry }> {
  validateDraft(state, draft, opts);
  const last = state.ledger[state.ledger.length - 1];
  const prevHash = last ? last.hash : GENESIS_HASH;
  const body = {
    seq: (last?.seq ?? 0) + 1,
    at: draft.at ?? opts.now ?? Date.now(),
    kind: draft.kind,
    lines: draft.lines.map((l) => ({ account: l.account, amount: l.amount })),
    ...(draft.ref ? { ref: draft.ref } : {}),
  };
  const hash = entryHash(prevHash, body);
  const signature = bytesToBase64Url(await signer(utf8Bytes(hash)));
  const entry: LedgerEntry = { ...body, prevHash, hash, signature };
  return { state: { ...state, ledger: [...state.ledger, entry] }, entry };
}

// ---------------------------------------------------------------------------------------------
// Chip economy: minting from platform certificates, burning rake, settling hands
// ---------------------------------------------------------------------------------------------

export function usedCertificateNonces(state: ClubState): Set<string> {
  const used = new Set<string>();
  for (const e of state.ledger) {
    if (e.kind !== 'mint' || !e.ref?.certificate) continue;
    try {
      used.add(decodeCertificate(e.ref.certificate).certificate.nonce);
    } catch {
      /* unreadable certificates are caught by verifyLedger */
    }
  }
  return used;
}

/** Mint chips into the reserve from a platform certificate (verified, single-use, matching club). */
export async function mint(
  state: ClubState,
  token: string,
  signer: Signer,
  opts: { platformPublicKey?: string; now?: number } = {},
): Promise<{ state: ClubState; entry: LedgerEntry; certificate: PlatformCertificate }> {
  const now = opts.now ?? Date.now();
  const platformKey = opts.platformPublicKey ?? PLATFORM_PUBLIC_KEY;
  const certificate = await verifyCertificate(token, platformKey, now);
  if (certificate.clubId !== state.identity.id) {
    throw new ClubError('wrong-club', 'that certificate is for another club');
  }
  if (certificate.currency !== state.identity.currency.code) {
    throw new ClubError(
      'bad-certificate',
      `certificate is in ${certificate.currency}, the club uses ${state.identity.currency.code}`,
    );
  }
  if (usedCertificateNonces(state).has(certificate.nonce)) {
    throw new ClubError('certificate-used', 'that certificate was already minted');
  }
  const draft: LedgerDraft = {
    kind: 'mint',
    lines: [{ account: HOUSE, amount: certificate.amount }],
    ref: { certificate: token },
    at: now,
  };
  const appended = await appendEntry(state, draft, signer, { now });
  return { ...appended, certificate };
}

/** Destroy chips (rake, entry fees). */
export async function burn(
  state: ClubState,
  input: {
    lines: Array<{ account: string; amount: number }>;
    ref?: LedgerEntry['ref'];
    at?: number;
  },
  signer: Signer,
): Promise<{ state: ClubState; entry: LedgerEntry }> {
  const draft: LedgerDraft = { kind: 'burn', lines: input.lines, ref: input.ref, at: input.at };
  return appendEntry(state, draft, signer, { now: input.at });
}

export interface HandTransfer {
  from: string;
  to: string;
  points: number;
}

export interface SettledHand {
  result: LedgerDraft;
  /** Null when nothing was raked (points-only table, or no chips moved). */
  burn: LedgerDraft | null;
  moved: number;
  rake: number;
  basisPoints: number;
}

/** Rake owed on `moved` chips at `basisPoints`, capped. */
export function rakeFor(moved: number, basisPoints: number, cap?: number): number {
  const raw = Math.floor((moved * basisPoints) / 10_000);
  return cap !== undefined ? Math.min(raw, cap) : raw;
}

/**
 * Turn one hand's point transfers into ledger drafts: a `result` moving chips between the seat
 * stacks, and a `burn` taking the rake from the winners in proportion to what they won. Rake
 * defaults to the platform minimum and can never be below it.
 */
export function settleHand(input: {
  tableId: string;
  game: string;
  hand?: number;
  transfers: HandTransfer[];
  stakes: TableStakes;
  at?: number;
}): SettledHand {
  const chipsPerPoint = input.stakes.chipsPerPoint;
  const net = new Map<string, number>();
  for (const t of input.transfers) {
    const chips = t.points * chipsPerPoint;
    if (chips === 0) continue;
    net.set(t.from, (net.get(t.from) ?? 0) - chips);
    net.set(t.to, (net.get(t.to) ?? 0) + chips);
  }
  const lines = Array.from(net, ([memberId, amount]) => ({
    account: tableAccount(input.tableId, memberId),
    amount,
  })).filter((l) => l.amount !== 0);
  const ref = {
    tableId: input.tableId,
    game: input.game,
    ...(input.hand !== undefined ? { hand: input.hand } : {}),
  };
  const result: LedgerDraft = { kind: 'result', lines, ref, at: input.at };
  const moved = lines.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0);
  const basisPoints = Math.max(
    PLATFORM_MIN_RAKE_BPS,
    input.stakes.rake?.basisPoints ?? PLATFORM_MIN_RAKE_BPS,
  );
  const rake = moved > 0 ? rakeFor(moved, basisPoints, input.stakes.rake?.cap) : 0;
  if (rake <= 0) return { result, burn: null, moved, rake: 0, basisPoints };
  // Split the rake across winners in proportion to their win; remainders go to the biggest winner.
  const winners = lines.filter((l) => l.amount > 0).sort((a, b) => b.amount - a.amount);
  const burnLines: Array<{ account: string; amount: number }> = [];
  let allocated = 0;
  for (const w of winners) {
    const share = Math.floor((rake * w.amount) / moved);
    if (share > 0) burnLines.push({ account: w.account, amount: -share });
    allocated += share;
  }
  const remainder = rake - allocated;
  if (remainder > 0) {
    const top = burnLines.find((l) => l.account === winners[0]!.account);
    if (top) top.amount -= remainder;
    else burnLines.push({ account: winners[0]!.account, amount: -remainder });
  }
  const burnDraft: LedgerDraft = {
    kind: 'burn',
    lines: burnLines,
    ref: { ...ref, basisPoints, moved },
    at: input.at,
  };
  return { result, burn: burnDraft, moved, rake, basisPoints };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export interface LedgerVerification {
  ok: boolean;
  entries: number;
  /** First problem found, if any. */
  problem?: { seq: number; reason: string };
  totals?: { minted: number; burned: number; reserve: number; circulation: number };
}

export interface VerifyLedgerOptions {
  /** Platform key certificates must verify against (default: the built-in platform key). */
  platformPublicKey?: string;
  /** Skip certificate checks (e.g. an offline check without the platform key). */
  skipCertificates?: boolean;
}

/**
 * Re-hash the chain, check every signature against the club key, and enforce the chip economy:
 * chips enter only through platform-signed, single-use certificates; the house is credited only
 * by mint, redeem and fee; the reserve never goes negative; minted − burned always covers what is
 * in circulation plus the reserve; every raked hand is followed by a burn of at least the
 * platform minimum.
 */
export async function verifyLedger(
  entries: LedgerEntry[],
  clubPublicKey: string,
  opts: VerifyLedgerOptions = {},
): Promise<LedgerVerification> {
  const fail = (i: number, seq: number, reason: string): LedgerVerification => ({
    ok: false,
    entries: i,
    problem: { seq, reason },
  });
  let prev = GENESIS_HASH;
  const running = new Map<string, number>();
  const nonces = new Set<string>();
  let mintedTotal = 0;
  let burnedTotal = 0;
  let pendingRake: { seq: number; tableId?: string; hand?: number; moved: number } | null = null;
  const circ = () => {
    let total = 0;
    for (const [account, amount] of running) if (account !== HOUSE) total += amount;
    return total;
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i + 1) return fail(i, e.seq, 'sequence gap');
    if (e.prevHash !== prev) return fail(i, e.seq, 'broken chain');
    if (entryHash(prev, e) !== e.hash) return fail(i, e.seq, 'hash mismatch');
    let sig: Uint8Array;
    try {
      sig = base64UrlToBytes(e.signature);
    } catch {
      return fail(i, e.seq, 'bad signature encoding');
    }
    if (!(await verify(clubPublicKey, utf8Bytes(e.hash), sig)))
      return fail(i, e.seq, 'bad signature');
    const sum = lineSum(e);
    if (e.kind === 'mint') {
      if (e.lines.length !== 1 || e.lines[0]!.account !== HOUSE || sum <= 0) {
        return fail(i, e.seq, 'malformed mint');
      }
      if (!opts.skipCertificates) {
        const token = e.ref?.certificate;
        if (!token) return fail(i, e.seq, 'mint without certificate');
        let cert: PlatformCertificate;
        try {
          cert = await verifyCertificate(
            token,
            opts.platformPublicKey ?? PLATFORM_PUBLIC_KEY,
            e.at,
          );
        } catch (err) {
          return fail(i, e.seq, `unbacked mint: ${(err as Error).message}`);
        }
        if (cert.amount !== sum) return fail(i, e.seq, 'mint amount differs from its certificate');
        if (nonces.has(cert.nonce)) return fail(i, e.seq, 'certificate reused');
        nonces.add(cert.nonce);
      }
      mintedTotal += sum;
    } else if (e.kind === 'burn') {
      if (e.lines.some((l) => l.amount >= 0 || l.account === HOUSE)) {
        return fail(i, e.seq, 'malformed burn');
      }
      burnedTotal += -sum;
    } else {
      if (sum !== 0) return fail(i, e.seq, 'unbalanced');
      const creditsHouse = e.lines.some((l) => l.account === HOUSE && l.amount > 0);
      if (creditsHouse && e.kind !== 'redeem' && e.kind !== 'fee') {
        return fail(i, e.seq, 'house credited outside mint/redeem/fee');
      }
    }
    // A raked result must be followed immediately by its burn.
    if (pendingRake) {
      const enough =
        e.kind === 'burn' &&
        e.ref?.tableId === pendingRake.tableId &&
        e.ref?.hand === pendingRake.hand &&
        -sum >= rakeFor(pendingRake.moved, PLATFORM_MIN_RAKE_BPS);
      if (!enough) return fail(i, e.seq, `result ${pendingRake.seq} was not raked`);
      pendingRake = null;
    }
    for (const l of e.lines) running.set(l.account, (running.get(l.account) ?? 0) + l.amount);
    if ((running.get(HOUSE) ?? 0) < 0) return fail(i, e.seq, 'reserve overdrawn');
    if (e.kind === 'result' && e.ref?.tableId) {
      const moved = e.lines.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0);
      if (moved > 0 && rakeFor(moved, PLATFORM_MIN_RAKE_BPS) > 0) {
        pendingRake = { seq: e.seq, tableId: e.ref.tableId, hand: e.ref.hand, moved };
      }
    }
    if (mintedTotal - burnedTotal < circ() + (running.get(HOUSE) ?? 0)) {
      return fail(i, e.seq, 'more chips than were minted');
    }
    prev = e.hash;
  }
  if (pendingRake) {
    return fail(entries.length, pendingRake.seq, `result ${pendingRake.seq} was not raked`);
  }
  return {
    ok: true,
    entries: entries.length,
    totals: {
      minted: mintedTotal,
      burned: burnedTotal,
      reserve: running.get(HOUSE) ?? 0,
      circulation: circ(),
    },
  };
}

const KIND_TEXT: Record<LedgerKind, string> = {
  mint: 'Chips minted',
  burn: 'Rake',
  grant: 'Grant from the club',
  redeem: 'Redeemed with the club',
  'buy-in': 'Buy-in',
  'cash-out': 'Cash-out',
  result: 'Hand result',
  transfer: 'Transfer',
  fee: 'Fee',
  adjust: 'Adjustment',
};

/** A one-line description of what an entry meant for `memberId`. */
export function describeEntry(entry: LedgerEntry, memberId: string): string {
  const ref = entry.ref ?? {};
  const where = ref.tableId ? ` at table ${ref.tableId}` : '';
  switch (entry.kind) {
    case 'result':
      return `Hand ${ref.hand ?? '?'} result${where}`;
    case 'burn':
      return `Rake on hand ${ref.hand ?? '?'}${where}`;
    case 'buy-in':
    case 'cash-out':
      return `${KIND_TEXT[entry.kind]}${where}`;
    case 'transfer': {
      const other = entry.lines.find((l) => l.account !== memberId)?.account;
      const mine = entry.lines.find((l) => l.account === memberId)?.amount ?? 0;
      return other
        ? `Transfer ${mine >= 0 ? 'from' : 'to'} ${other}${ref.note ? ` (${ref.note})` : ''}`
        : 'Transfer';
    }
    default:
      return `${KIND_TEXT[entry.kind]}${ref.note ? ` (${ref.note})` : ''}`;
  }
}

/**
 * A member's own entries plus the signed head of the ledger they are part of, flattened into a
 * readable history (running balance per row) so a member can see where their chips went.
 */
export function statementFor(state: ClubState, memberId: string): MemberStatement {
  const entries = state.ledger.filter((e) => e.lines.some((l) => l.account === memberId));
  const last = state.ledger[state.ledger.length - 1];
  let running = 0;
  const history: StatementLine[] = entries.map((e) => {
    const amount = e.lines.filter((l) => l.account === memberId).reduce((a, l) => a + l.amount, 0);
    running += amount;
    return {
      seq: e.seq,
      at: e.at,
      kind: e.kind,
      amount,
      balance: running,
      description: describeEntry(e, memberId),
      ...(e.ref ? { ref: e.ref } : {}),
    };
  });
  return {
    memberId,
    balance: balanceOf(state, memberId),
    entries,
    history,
    head: last
      ? { seq: last.seq, hash: last.hash, signature: last.signature }
      : { seq: 0, hash: GENESIS_HASH, signature: '' },
  };
}

/** Verify a statement's entries against the club key (chain continuity is not visible to a member). */
export async function verifyStatement(
  statement: MemberStatement,
  clubPublicKey: string,
): Promise<boolean> {
  for (const e of statement.entries) {
    if (entryHash(e.prevHash, e) !== e.hash) return false;
    let sig: Uint8Array;
    try {
      sig = base64UrlToBytes(e.signature);
    } catch {
      return false;
    }
    if (!(await verify(clubPublicKey, utf8Bytes(e.hash), sig))) return false;
  }
  if (statement.head.seq > 0) {
    try {
      const headSig = base64UrlToBytes(statement.head.signature);
      if (!(await verify(clubPublicKey, utf8Bytes(statement.head.hash), headSig))) return false;
    } catch {
      return false;
    }
  }
  const mine = statement.entries.reduce(
    (a, e) =>
      a + e.lines.filter((l) => l.account === statement.memberId).reduce((b, l) => b + l.amount, 0),
    0,
  );
  return mine === statement.balance;
}
