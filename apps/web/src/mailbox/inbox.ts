import type { MatchSnapshot, PlayerProfile, TableSnapshot } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import type { MatchState } from '@bgf/engine';
import type { Runtime } from '../session/runtimes';
import type { MailboxDevice } from './client';
import { ackMail, fetchInbox, sendMail } from './client';
import { open, seal } from './crypto';
import type { Envelope } from './envelope';
import { isEnvelope } from './envelope';
import type { MailedCommand } from './apply';
import { applyMailed } from './apply';
import type { Incoming } from './service';
import { backgammonTurn, ofcTurn } from './turns';

type AnySnapshot = (MatchSnapshot | TableSnapshot) & { id: string; seq: number };

/** A saved match this device knows, and where it lives. */
export interface KnownMatch {
  game: string;
  snapshot: AnySnapshot;
  put(snapshot: AnySnapshot): Promise<void>;
}

/** What processing the inbox needs from where it runs (a page, or the service worker). */
export interface InboxEnv {
  device: MailboxDevice;
  findMatch(matchId: string): Promise<KnownMatch | undefined>;
  /** A table this device is hosting live right now. */
  liveHost?(
    game: string,
    matchId: string,
  ):
    | {
        deliver(
          seat: number,
          msg: MailedCommand['msg'],
        ): Promise<{ errors: { code: string; message: string }[] }>;
      }
    | undefined;
  /** A live session for the match that is not hosting it (connected, or playing by mail). */
  liveGuest?(
    game: string,
    matchId: string,
  ): { mailed(e: Extract<Envelope, { t: 'view' }>): void } | undefined;
  runtimeFor(pin: string | undefined): Promise<Runtime>;
  /** Whether mailed moves for a table pinned to `pin` can be applied here. */
  canApply?(pin: string | undefined): boolean;
  entropyFor?(provider: string | undefined): EntropySource | undefined;
}

export type InboxEvent =
  | {
      kind: 'view';
      game: string;
      matchId: string;
      from: string;
      yourTurn: boolean;
      stored: boolean;
    }
  | { kind: 'applied'; game: string; matchId: string; from: string; moves: number }
  | { kind: 'deferred'; game: string; matchId: string; from: string; moves: number };

const keyOf = (s: AnySnapshot): string | undefined => {
  const m = s as MatchSnapshot;
  if (typeof m.mailboxKey === 'string') return m.mailboxKey;
  const k = (s as TableSnapshot).options?.mailboxKey;
  return typeof k === 'string' ? k : undefined;
};
const pinOf = (s: AnySnapshot): string | undefined => {
  const m = s as MatchSnapshot;
  if (typeof m.runtime === 'string') return m.runtime;
  const p = (s as TableSnapshot).options?.runtime;
  return typeof p === 'string' ? p : undefined;
};

/** Chat does not advance `seq`, so a copy with the same position but more chat is newer too. */
export function isNewer(incoming: AnySnapshot, current: AnySnapshot): boolean {
  if (incoming.seq !== current.seq) return incoming.seq > current.seq;
  return (incoming.chat?.length ?? 0) > (current.chat?.length ?? 0);
}

/** The seats of either snapshot shape, by index. */
function seatsOf(game: string, s: AnySnapshot): (PlayerProfile | null)[] {
  if (game === 'backgammon') {
    const m = s as MatchSnapshot;
    return [m.players.white ?? null, m.players.black ?? null];
  }
  return (s as TableSnapshot).seats as (PlayerProfile | null)[];
}

/** Whether `player` (a root key) has something to do in this snapshot. */
function turnOf(game: string, s: AnySnapshot, player: string): boolean {
  const seat = seatsOf(game, s).findIndex((p) => p?.publicKey === player);
  if (seat < 0) return false;
  if (game === 'backgammon') return backgammonTurn((s as MatchSnapshot).match as MatchState, seat);
  if (game === 'ofc') return ofcTurn((s as TableSnapshot).state, seat);
  return false;
}

/**
 * Collect and act on this device's mail:
 *
 *  - a position (`view`) newer than the saved copy replaces it, and any live session for the
 *    match is told; for backgammon that full copy also lets this device host the match next;
 *  - moves (`cmd`) for a table this device hosts are applied: by the live table when it is open
 *    here, else by restoring it from the saved copy (`applyMailed`), after which every other
 *    player is mailed their new view. Moves that cannot be applied here (the service worker
 *    lacks the pinned rules) are left in the mailbox for a page to apply.
 *
 * Everything handled is removed from the mailbox. Returns what happened, for notifications.
 */
export async function processInbox(env: InboxEnv): Promise<InboxEvent[]> {
  const mail = await fetchInbox(env.device.token);
  const events: InboxEvent[] = [];
  const done: number[] = [];
  const opened: { m: Incoming; e: Envelope; known: KnownMatch }[] = [];
  for (const m of mail) {
    const known = await env.findMatch(m.match);
    if (!known) {
      // Not saved on this device (yet): another of the player's devices may have it. Drop it
      // only once it is old, so a match saved a moment later still gets its mail.
      if (Date.now() - m.at > 7 * 24 * 3600_000) done.push(m.id);
      continue;
    }
    const key = keyOf(known.snapshot);
    const e = key ? await open(key, m.match, m.body) : null;
    if (!isEnvelope(e) || e.game !== known.game) {
      done.push(m.id); // not sealed with this match's key: nothing we can or should read
      continue;
    }
    opened.push({ m, e, known });
  }

  // Positions first: the newest per match wins.
  for (const { m, e, known } of opened) {
    if (e.t !== 'view') continue;
    done.push(m.id);
    const incoming = e.snapshot as unknown as AnySnapshot;
    const current = (await env.findMatch(m.match))?.snapshot ?? known.snapshot;
    // Only the device's own player's matches, and never someone else's match under this id.
    if (incoming.id !== current.id) continue;
    const newer = isNewer(incoming, current);
    // A device hosting the match keeps its own copy: it is the table.
    const hosting = env.liveHost?.(known.game, m.match);
    let stored = false;
    if (newer && !hosting) {
      await known.put(incoming);
      stored = true;
    }
    env.liveGuest?.(known.game, m.match)?.mailed(e);
    events.push({
      kind: 'view',
      game: known.game,
      matchId: m.match,
      from: m.from,
      yourTurn: newer && turnOf(known.game, incoming, env.device.player),
      stored,
    });
  }

  // Then moves, grouped per match, in the order they were sent.
  const byMatch = new Map<
    string,
    { known: KnownMatch; cmds: (MailedCommand & { id: number })[] }
  >();
  for (const { m, e, known } of opened) {
    if (e.t !== 'cmd') continue;
    const entry = byMatch.get(m.match) ?? { known, cmds: [] };
    entry.cmds.push({ seat: e.seat, msg: e.msg, from: m.from, id: m.id });
    byMatch.set(m.match, entry);
  }
  for (const [matchId, { known, cmds }] of byMatch) {
    const from = cmds[0]!.from;
    const live = env.liveHost?.(known.game, matchId);
    if (live) {
      for (const c of cmds) {
        const seated = seatsOf(known.game, known.snapshot)[c.seat];
        if (seated?.publicKey !== c.from) continue;
        const out = await live.deliver(c.seat, c.msg);
        if (out.errors.length) await mailErrors(env, known, c.seat, out.errors);
      }
      done.push(...cmds.map((c) => c.id));
      events.push({ kind: 'applied', game: known.game, matchId, from, moves: cmds.length });
      continue;
    }
    const snap = (await env.findMatch(matchId))?.snapshot ?? known.snapshot;
    const table = snap as TableSnapshot;
    const pin = pinOf(snap);
    if (known.game === 'backgammon' || table.view || (env.canApply && !env.canApply(pin))) {
      // Not ours to apply (a backgammon match is played by whoever hosts it; a view cannot host),
      // or not here: leave it for a page.
      if (known.game === 'backgammon' || table.view) done.push(...cmds.map((c) => c.id));
      else events.push({ kind: 'deferred', game: known.game, matchId, from, moves: cmds.length });
      continue;
    }
    const rt = await env.runtimeFor(pin);
    const provider = (table.options?.randomness as { provider?: string } | undefined)?.provider;
    const applied = await applyMailed(rt, table, cmds, {
      entropy: env.entropyFor?.(provider),
    });
    await known.put(applied.snapshot as AnySnapshot);
    await mailViews(env, known.game, applied.snapshot, applied.errors, rt);
    done.push(...cmds.map((c) => c.id));
    events.push({ kind: 'applied', game: known.game, matchId, from, moves: cmds.length });
  }

  await ackMail(env.device.token, done);
  return events;
}

/** After applying mailed moves: every other player gets their view (and their errors). */
async function mailViews(
  env: InboxEnv,
  game: string,
  snapshot: TableSnapshot,
  errors: Map<number, { code: string; message: string }[]>,
  rt: Runtime,
): Promise<void> {
  const key = snapshot.options?.mailboxKey;
  if (typeof key !== 'string') return;
  const def = (rt.definitions as Record<string, Parameters<Runtime['viewSnapshot']>[0]>)[game];
  if (!def) return;
  for (const [seat, p] of snapshot.seats.entries()) {
    if (seat === snapshot.hostSeat || !p?.publicKey) continue;
    const envelope: Envelope = {
      v: 1,
      t: 'view',
      game,
      snapshot: rt.viewSnapshot(def, snapshot, seat) as unknown as Extract<
        Envelope,
        { t: 'view' }
      >['snapshot'],
      ...(errors.get(seat) ? { errors: errors.get(seat) } : {}),
    };
    await sendMail(env.device.token, {
      to: p.publicKey,
      match: snapshot.id,
      kind: 'view',
      body: await seal(key, snapshot.id, envelope),
      notify: ofcTurn(snapshot.state, seat) || !!errors.get(seat),
    });
  }
}

/** A live table refused a mailed move: tell its sender, with the position as it stands. */
async function mailErrors(
  env: InboxEnv,
  known: KnownMatch,
  seat: number,
  errors: { code: string; message: string }[],
): Promise<void> {
  const key = keyOf(known.snapshot);
  const to = seatsOf(known.game, known.snapshot)[seat]?.publicKey;
  if (!key || !to) return;
  const envelope: Envelope = {
    v: 1,
    t: 'view',
    game: known.game,
    snapshot: known.snapshot as unknown as Extract<Envelope, { t: 'view' }>['snapshot'],
    live: true,
    errors,
  };
  await sendMail(env.device.token, {
    to,
    match: known.snapshot.id,
    kind: 'view',
    body: await seal(key, known.snapshot.id, envelope),
    notify: true,
  });
}
