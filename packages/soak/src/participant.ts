import type { MatchState } from '@bgf/engine';
import type { TableState, TableView } from '@bgf/ofc-engine';
import type { KeyPair, PlayerProfile, TableSnapshot, TransportProvider } from '@bgf/protocol';
import { generateKeyPair, signerFor } from '@bgf/protocol';
import type { TableClientState } from '@bgf/table';
import { TableClient } from '@bgf/table';
import { seatPlayer } from '@bgf/server';
import { ofcBot } from './bots/ofc.js';
import { backgammonBot } from './bots/backgammon.js';

export type SoakGame = 'ofc' | 'backgammon';

export interface ParticipantOptions {
  name: string;
  /** Existing identity; a fresh keypair is generated when omitted. */
  keys?: KeyPair;
  profileId?: string;
  provider: TransportProvider;
  code: string;
  game: SoakGame;
  /** Override the bot (state → command | null). Defaults to the package bots. */
  bot?: (state: unknown, seat: number) => unknown;
  rng?: { int(n: number): number };
  /** How long to wait for the seat before giving up. Default 20 s. */
  joinTimeoutMs?: number;
  /** Act from a timer instead of synchronously on every snapshot. Over the in-memory transport
   *  (microtask delivery) bots would otherwise starve the event loop of macrotasks, so anything
   *  waiting on I/O or WebCrypto (ledger signing, file writes) never gets a turn. */
  actDelayMs?: number;
}

export interface ViewViolation {
  seq: number;
  what: string;
}

export interface ParticipantStats {
  /** Commands sent by the bot. */
  commands: number;
  /** Rule errors the server sent back (a bot bug or a race). */
  errors: Array<{ code: string; message: string }>;
  /** Snapshots received. */
  snapshots: number;
  /** Hidden information that leaked into a view (must stay empty). */
  violations: ViewViolation[];
  readySent: number;
}

export interface Participant {
  name: string;
  seat: number;
  client: TableClient;
  stats: ParticipantStats;
  onState(cb: (state: TableClientState) => void): () => void;
  /** Latest snapshot this seat has seen. */
  snapshot(): TableSnapshot | null;
  close(): void;
}

/** Check that a redacted OFC view never carries what this seat may not see. */
export function ofcViewViolations(view: TableView, seat: number): string[] {
  const out: string[] = [];
  const hand = view.hand as (TableView['hand'] & { deck?: unknown }) | null;
  if (!hand) return out;
  if (hand.deck !== undefined) out.push('deck present in view');
  hand.seats.forEach((s, i) => {
    if (i === seat) return;
    if (s.pending.length > 0) out.push(`seat ${i} pending cards visible`);
    if (s.discards.length > 0) out.push(`seat ${i} discards visible`);
    if (s.hiddenCount > 0) {
      const set = s.rows.top.length + s.rows.middle.length + s.rows.bottom.length;
      if (set > 0) out.push(`seat ${i} face-down cards visible`);
    }
  });
  return out;
}

/** A bot that joins a table by code over any transport and plays its seat until closed. */
export async function createParticipant(opts: ParticipantOptions): Promise<Participant> {
  const keys = opts.keys ?? (await generateKeyPair());
  const profile: PlayerProfile = {
    id: opts.profileId ?? `bot-${opts.name.toLowerCase()}-${keys.publicKey.slice(0, 8)}`,
    name: opts.name,
    publicKey: keys.publicKey,
  };
  const transport = await opts.provider.join(opts.code, {
    timeoutMs: opts.joinTimeoutMs ?? 20_000,
  });
  const client = new TableClient({
    transport,
    profile,
    signer: signerFor(keys.privateKey),
    pingIntervalMs: 0,
  });
  const stats: ParticipantStats = {
    commands: 0,
    errors: [],
    snapshots: 0,
    violations: [],
    readySent: 0,
  };
  const listeners = new Set<(s: TableClientState) => void>();
  let lastSeq = -1;
  let lastErrorAt = 0;
  let lastKey = '';
  let readyFor = '';
  let closed = false;

  const act = () => {
    if (closed) return;
    const st = client.getState();
    if (st.error && st.error.at !== lastErrorAt) {
      lastErrorAt = st.error.at;
      stats.errors.push({ code: st.error.code, message: st.error.message });
    }
    if (st.status !== 'joined' || st.seat === null || !st.snapshot) return;
    const seat = st.seat;
    const snap = st.snapshot;
    if (snap.seq !== lastSeq) {
      lastSeq = snap.seq;
      stats.snapshots++;
      if (opts.game === 'ofc' && snap.view) {
        for (const what of ofcViewViolations(snap.state as TableView, seat)) {
          stats.violations.push({ seq: snap.seq, what });
        }
      }
    }
    if (opts.game === 'ofc') {
      const state = snap.state as TableState;
      const hand = state.hand;
      if (hand && hand.phase === 'setting') {
        const me = hand.seats[seat]!;
        // A Fantasyland seat acts on its own cards only; a normal seat also waits for its turn.
        const turn = me.fantasyland ? 'fl' : String(hand.toAct);
        const key = `${state.handNumber}:${turn}:${me.pending.map((c) => c.rank + c.suit).join('')}:${me.done}`;
        if (key !== lastKey) {
          const cmd = opts.bot ? opts.bot(state, seat) : ofcBot(state, seat, { rng: opts.rng });
          if (cmd) {
            lastKey = key;
            if (client.send(cmd)) stats.commands++;
          }
        }
      } else if (hand && (hand.phase === 'complete' || hand.phase === 'showdown')) {
        const key = `hand-${state.handNumber}`;
        if (readyFor !== key && !st.ready?.[seat]) {
          readyFor = key;
          if (client.setReady(true)) stats.readySent++;
        }
      }
      return;
    }
    // backgammon
    const match = snap.state as MatchState;
    const player = seatPlayer(seat);
    const game = match.game;
    if (game && game.phase.kind === 'over') {
      const key = `game-${match.gameNumber}`;
      if (readyFor !== key && !st.ready?.[seat]) {
        readyFor = key;
        if (client.setReady(true)) stats.readySent++;
      }
      return;
    }
    if (!game) return; // the autopilot starts games on unattended tables
    // Key on the decision point, not the snapshot: while our command is in flight the opponent's
    // opening roll (or a presence change) produces new snapshots that must not trigger a resend.
    const ph = game.phase;
    const key = `${match.gameNumber}:${game.history.length}:${ph.kind}:${ph.kind === 'opening' ? ph.ties : ''}`;
    if (key === lastKey) return;
    const cmd = opts.bot ? opts.bot(match, seat) : backgammonBot(match, player, { rng: opts.rng });
    if (cmd) {
      lastKey = key;
      if (client.send(cmd)) stats.commands++;
    }
  };

  let actTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAct = () => {
    if (opts.actDelayMs === undefined) {
      act();
      return;
    }
    if (actTimer) return;
    actTimer = setTimeout(() => {
      actTimer = null;
      act();
    }, opts.actDelayMs);
  };

  client.subscribe(() => {
    scheduleAct();
    const st = client.getState();
    for (const l of Array.from(listeners)) l(st);
  });

  const seat = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${opts.name}: no seat within ${opts.joinTimeoutMs ?? 20_000} ms`)),
      opts.joinTimeoutMs ?? 20_000,
    );
    const check = () => {
      const st = client.getState();
      if (st.status === 'joined' && st.seat !== null) {
        clearTimeout(timer);
        unsub();
        resolve(st.seat);
      } else if (st.status === 'rejected') {
        clearTimeout(timer);
        unsub();
        reject(new Error(`${opts.name}: rejected (${st.rejectReason ?? 'unknown'})`));
      }
    };
    const unsub = client.subscribe(check);
    check();
  });
  scheduleAct();

  return {
    name: opts.name,
    seat,
    client,
    stats,
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot: () => client.getState().snapshot,
    close() {
      closed = true;
      if (actTimer) clearTimeout(actTimer);
      client.close();
    },
  };
}
