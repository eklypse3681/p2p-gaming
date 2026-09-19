import type { MatchConfig, MatchState } from '@bgf/engine';
import type { TableConfig, TableState } from '@bgf/ofc-engine';
import { defaultConfig, ofcDefinition } from '@bgf/ofc-engine';
import type { Listener, TableSnapshot, TransportProvider } from '@bgf/protocol';
import { generateKeyPair, memoryProvider } from '@bgf/protocol';
import type { EntropySource, GameDefinition } from '@bgf/table';
import { TableServer, seededRng, verifySnapshot } from '@bgf/table';
import { backgammonDefinition } from '@bgf/server';
import { cryptoProvider, drandProvider, randomOrgProvider } from '@bgf/entropy';
import { peerJsProvider } from '@bgf/transport-peerjs';
import type { Participant, SoakGame } from './participant.js';
import { createParticipant } from './participant.js';

export type RandomnessMode = 'per-draw' | 'seeded' | 'beacon';

export interface SoakOptions {
  game: SoakGame;
  /** OFC only. */
  variant?: 'ofc' | 'pineapple' | 'pineapple27';
  /** Game config overrides (OFC `TableConfig` or backgammon `MatchConfig`). */
  config?: Record<string, unknown>;
  seats?: number;
  /** OFC: hands to complete. */
  hands?: number;
  /** Backgammon: games to complete (money play unless `config.length` is set). */
  games?: number;
  provider?: 'memory' | 'peerjs';
  /** `inline`: host a dealer-mode table in this process; `runtime`: join an existing table by `code`. */
  dealer?: 'inline' | 'runtime';
  code?: string;
  entropy?: 'crypto' | 'random.org' | 'drand';
  apiKey?: string;
  randomness?: RandomnessMode;
  /** Deterministic bot tie-breaks and (inline, crypto entropy) table randomness. */
  seed?: number;
  timeoutMs?: number;
  names?: string[];
  onProgress?: (p: { completed: number; target: number }) => void;
}

export interface SeatStats {
  name: string;
  seat: number;
  score: number;
  fouls: number;
  royalties: number;
  fantasyland: number;
  fantasyland15: number;
  stayedInFantasyland: number;
  commands: number;
  errors: number;
}

export interface SoakReport {
  game: SoakGame;
  variant?: string;
  seats: number;
  completed: number;
  target: number;
  wallMs: number;
  actions: number;
  seq: number;
  provider: string;
  entropy: string;
  randomness: RandomnessMode;
  zeroSum: boolean;
  scoresSum: number;
  averageHandMs: number;
  perSeat: SeatStats[];
  /** Backgammon: game results. */
  backgammon?: {
    games: number;
    singles: number;
    gammons: number;
    backgammons: number;
    doubles: number;
    maxCube: number;
    matchesWon: Record<string, number>;
  };
  invariants: Array<{ name: string; ok: boolean; detail?: string }>;
  ok: boolean;
  errors: Array<{ who: string; code: string; message: string }>;
}

function pickProvider(kind: 'memory' | 'peerjs', namespace: string): TransportProvider {
  return kind === 'peerjs' ? peerJsProvider({ namespace }) : memoryProvider();
}

function entropySource(kind: 'crypto' | 'random.org' | 'drand', apiKey?: string): EntropySource {
  if (kind === 'random.org') {
    if (!apiKey) throw new Error('random.org needs --api-key');
    return randomOrgProvider({ apiKey });
  }
  if (kind === 'drand') return drandProvider();
  return cryptoProvider();
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

interface Hosted {
  server: TableServer<unknown, unknown, unknown, unknown, unknown>;
  listener: Listener;
}

async function hostInline(
  def: GameDefinition<unknown, unknown, unknown, unknown, unknown>,
  provider: TransportProvider,
  code: string,
  config: unknown,
  seats: number,
  opts: SoakOptions,
): Promise<Hosted> {
  const keys = await generateKeyPair();
  const listener = await provider.host(code);
  const entropy = opts.entropy ?? 'crypto';
  const randomness = opts.randomness ?? 'per-draw';
  const useEntropy = entropy !== 'crypto' || randomness !== 'per-draw';
  const server = await TableServer.create<unknown, unknown, unknown, unknown, unknown>({
    def,
    config,
    code,
    host: { id: 'soak-dealer', name: 'Soak dealer', publicKey: keys.publicKey },
    hostSeat: null,
    seats,
    options: { randomness: { mode: randomness, provider: entropy }, autopilot: true },
    ...(useEntropy ? { entropy: { source: entropySource(entropy, opts.apiKey) } } : {}),
    ...(opts.seed !== undefined && !useEntropy ? { rng: seededRng(opts.seed) } : {}),
  });
  listener.onConnection((t) => server.accept(t));
  return { server, listener };
}

/** Run a soak and return the report; throws only on setup failures (invariants are reported). */
export async function runSoak(opts: SoakOptions): Promise<SoakReport> {
  const game = opts.game;
  const def = (game === 'ofc' ? ofcDefinition : backgammonDefinition) as unknown as GameDefinition<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;
  const seats = opts.seats ?? (game === 'ofc' ? 3 : 2);
  const target = game === 'ofc' ? (opts.hands ?? 100) : (opts.games ?? 20);
  const providerKind = opts.provider ?? 'memory';
  const provider = pickProvider(providerKind, `${game}-v1`);
  const code = opts.code ?? randomCode();
  const config: unknown =
    game === 'ofc'
      ? defaultConfig({
          variant: opts.variant ?? 'pineapple',
          seats: seats as 2 | 3,
          ...(opts.config as Partial<TableConfig>),
        })
      : ({
          length: 0,
          crawford: true,
          jacoby: true,
          ...(opts.config as Partial<MatchConfig>),
        } satisfies Partial<MatchConfig>);
  const names = opts.names ?? ['Ada', 'Bob', 'Cy', 'Dee'];
  const t0 = Date.now();
  const rng = opts.seed !== undefined ? seededRng(opts.seed) : undefined;

  let hosted: Hosted | null = null;
  if ((opts.dealer ?? 'inline') === 'inline') {
    hosted = await hostInline(def, provider, code, config, seats, opts);
  }
  const participants: Participant[] = [];
  const handTimes: number[] = [];
  let completed = 0;
  let lastCompletedAt = Date.now();
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => (resolveDone = r));
  const progress = (snap: TableSnapshot | null) => {
    if (!snap) return;
    const n =
      game === 'ofc'
        ? (snap.state as TableState).history.length
        : (snap.state as MatchState).games.length;
    if (n > completed) {
      const now = Date.now();
      for (let i = completed; i < n; i++) handTimes.push(now - lastCompletedAt);
      lastCompletedAt = now;
      completed = n;
      opts.onProgress?.({ completed, target });
      if (completed >= target) resolveDone?.();
    }
  };
  for (let i = 0; i < seats; i++) {
    const p = await createParticipant({
      name: names[i] ?? `Bot${i + 1}`,
      provider,
      code,
      game,
      rng,
    });
    p.onState((st) => progress(st.snapshot));
    participants.push(p);
  }
  if (hosted) hosted.server.onChange((snap) => progress(snap));
  const timeoutMs = opts.timeoutMs ?? Math.max(60_000, target * 4_000);
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  const wallMs = Date.now() - t0;

  // ---- collect -------------------------------------------------------------------------
  const authoritative: TableSnapshot | null = hosted
    ? (hosted.server.getSnapshot() as TableSnapshot)
    : (participants[0]?.snapshot() ?? null);
  const invariants: SoakReport['invariants'] = [];
  const errors: SoakReport['errors'] = [];
  for (const p of participants) for (const e of p.stats.errors) errors.push({ who: p.name, ...e });
  const seatName = (i: number) => participants.find((p) => p.seat === i)?.name ?? `seat ${i}`;

  let perSeat: SeatStats[] = [];
  let zeroSum = true;
  let scoresSum = 0;
  let backgammon: SoakReport['backgammon'];
  if (authoritative && game === 'ofc') {
    const state = authoritative.state as TableState;
    const hist = state.history;
    zeroSum = hist.every((h) => h.seats.reduce((a, s) => a + s.points, 0) === 0);
    scoresSum = state.scores.reduce((a, b) => a + b, 0);
    perSeat = state.scores.map((score, i) => {
      const p = participants.find((x) => x.seat === i);
      return {
        name: seatName(i),
        seat: i,
        score,
        fouls: hist.filter((h) => h.seats[i]!.fouled).length,
        royalties: hist.reduce((a, h) => a + h.seats[i]!.royalties, 0),
        fantasyland: hist.filter((h) => h.seats[i]!.fantasylandNext > 0).length,
        fantasyland15: hist.filter((h) => h.seats[i]!.fantasylandNext >= 15).length,
        stayedInFantasyland: hist.filter(
          (h, k) =>
            k > 0 && hist[k - 1]!.seats[i]!.fantasylandNext > 0 && h.seats[i]!.fantasylandNext > 0,
        ).length,
        commands: p?.stats.commands ?? 0,
        errors: p?.stats.errors.length ?? 0,
      };
    });
    const buyIn = state.config.scoring.mode === 'buyin' ? (state.config.scoring.buyIn ?? 0) : 0;
    invariants.push({ name: 'every hand is zero-sum', ok: zeroSum });
    invariants.push({
      name: 'scores conserve points',
      ok: scoresSum === 0 || scoresSum === buyIn * state.config.seats,
      detail: `sum ${scoresSum}`,
    });
  } else if (authoritative && game === 'backgammon') {
    const match = authoritative.state as MatchState;
    const won: Record<string, number> = {};
    let singles = 0;
    let gammons = 0;
    let backgammons = 0;
    let doubles = 0;
    let maxCube = 1;
    for (const g of match.games) {
      if (g.result.kind === 'single') singles++;
      else if (g.result.kind === 'gammon') gammons++;
      else backgammons++;
      if (g.result.cube > 1) doubles++;
      maxCube = Math.max(maxCube, g.result.cube);
    }
    if (match.winner) won[match.winner] = (won[match.winner] ?? 0) + 1;
    backgammon = {
      games: match.games.length,
      singles,
      gammons,
      backgammons,
      doubles,
      maxCube,
      matchesWon: won,
    };
    const pointsWon = { white: 0, black: 0 };
    for (const g of match.games) pointsWon[g.result.winner] += g.result.points;
    const consistent =
      pointsWon.white === match.score.white && pointsWon.black === match.score.black;
    invariants.push({
      name: 'score equals points won',
      ok: consistent,
      detail: JSON.stringify(match.score),
    });
    perSeat = [0, 1].map((i) => {
      const p = participants.find((x) => x.seat === i);
      const player = i === 0 ? 'white' : 'black';
      return {
        name: seatName(i),
        seat: i,
        score: match.score[player],
        fouls: 0,
        royalties: 0,
        fantasyland: 0,
        fantasyland15: 0,
        stayedInFantasyland: 0,
        commands: p?.stats.commands ?? 0,
        errors: p?.stats.errors.length ?? 0,
      };
    });
  }
  if (hosted) {
    try {
      const verified = verifySnapshot(def, hosted.server.getSnapshot());
      const same =
        JSON.stringify(verified.state) === JSON.stringify(hosted.server.getSnapshot().state);
      invariants.push({ name: 'host snapshot replays from its action log', ok: same });
    } catch (e) {
      invariants.push({
        name: 'host snapshot replays from its action log',
        ok: false,
        detail: String(e),
      });
    }
  }
  const leaks = participants.flatMap((p) =>
    p.stats.violations.map((v) => `${p.name}@${v.seq}: ${v.what}`),
  );
  invariants.push({
    name: 'guest views never leak hidden information',
    ok: leaks.length === 0,
    detail: leaks.slice(0, 3).join('; ') || undefined,
  });
  invariants.push({
    name: 'no rule errors from bots',
    ok: errors.length === 0,
    detail: errors[0] ? `${errors[0].who}: ${errors[0].code}` : undefined,
  });
  invariants.push({
    name: 'reached the target',
    ok: completed >= target,
    detail: `${completed}/${target}`,
  });

  for (const p of participants) p.close();
  hosted?.listener.close();
  hosted?.server.close();

  return {
    game,
    variant: game === 'ofc' ? (config as TableConfig).variant : undefined,
    seats,
    completed,
    target,
    wallMs,
    actions: authoritative?.actions.length ?? 0,
    seq: authoritative?.seq ?? 0,
    provider: providerKind,
    entropy: opts.entropy ?? 'crypto',
    randomness: opts.randomness ?? 'per-draw',
    zeroSum,
    scoresSum,
    averageHandMs: handTimes.length
      ? Math.round(handTimes.reduce((a, b) => a + b, 0) / handTimes.length)
      : 0,
    perSeat,
    backgammon,
    invariants,
    ok: invariants.every((i) => i.ok),
    errors,
  };
}

/** Render a report as a compact fixed-width table. */
export function formatReport(r: SoakReport): string {
  const lines: string[] = [];
  const head = `${r.game}${r.variant ? ` · ${r.variant}` : ''} · ${r.seats} seats · ${r.completed}/${r.target} ${
    r.game === 'ofc' ? 'hands' : 'games'
  } · ${(r.wallMs / 1000).toFixed(1)} s · ${r.actions} actions · ${r.provider} · ${r.entropy}/${r.randomness}`;
  lines.push(head);
  if (r.game === 'ofc') {
    lines.push(
      pad(['seat', 'score', 'fouls', 'royalties', 'FL', 'FL15', 'stayed', 'cmds', 'errs']),
    );
    for (const s of r.perSeat)
      lines.push(
        pad([
          s.name,
          s.score,
          s.fouls,
          s.royalties,
          s.fantasyland,
          s.fantasyland15,
          s.stayedInFantasyland,
          s.commands,
          s.errors,
        ]),
      );
    lines.push(
      `average hand ${r.averageHandMs} ms · scores sum ${r.scoresSum} · zero-sum ${r.zeroSum ? 'yes' : 'NO'}`,
    );
  } else if (r.backgammon) {
    const b = r.backgammon;
    lines.push(pad(['seat', 'score', 'cmds', 'errs']));
    for (const s of r.perSeat) lines.push(pad([s.name, s.score, s.commands, s.errors]));
    lines.push(
      `games ${b.games} · singles ${b.singles} · gammons ${b.gammons} · backgammons ${b.backgammons} · cubed ${b.doubles} · max cube ${b.maxCube}`,
    );
  }
  for (const i of r.invariants)
    lines.push(`${i.ok ? '✓' : '✗'} ${i.name}${i.detail ? ` (${i.detail})` : ''}`);
  return lines.join('\n');
}

function pad(cells: Array<string | number>): string {
  return cells.map((c, i) => String(c).padEnd(i === 0 ? 10 : 9)).join('');
}
