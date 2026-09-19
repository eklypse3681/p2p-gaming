import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Command, TableConfig, TableState, TableView } from '@bgf/ofc-engine';
import { balances as engineBalances, view as engineView } from '@bgf/ofc-engine';
import type { TableClientState } from '@bgf/table';
import { DEALER_SEAT } from '@bgf/protocol';
import type { RandomnessMode } from '@bgf/protocol';
import { SessionError } from '../../session/session';
import type { FlowProgress } from '../../session/retry';
import { getSettings } from '../../session/settings';
import { randomnessFromSettings } from '../../session/entropy';
import { FairnessPanel } from '../../hud/FairnessPanel';
import { TrustBadge } from '../../hud/TrustBadge';
import type { TrustDescription } from '@bgf/table';
import { describeTrust } from '@bgf/table';
import { ofcDefinition } from '@bgf/ofc-engine';
import { useSession, useSessionRegistry } from '../../session/SessionRegistry';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { getSnapshotStore } from '../../session/matchStore';
import { LANDSCAPE_PHONE_QUERY, useMediaQuery } from '../../session/useMediaQuery';
import { useTheme } from '../../app/ThemeProvider';
import { RoomCode } from '../../hud/RoomCode';
import { Handoff } from '../../hud/Handoff';
import { ClubChip } from '../../clubs/ClubChip';
import { useToasts } from '../../hud/Toast';
import { useKeyboardShortcuts } from '../../hud/useKeyboardShortcuts';
import { OfcTable } from './table/OfcTable';
import { SeatStrip } from './hud/SeatStrip';
import { TableChat } from './hud/TableChat';
import { TableConnectionBadge } from './hud/TableConnectionBadge';
import { LedgerSheet } from './ledger/LedgerSheet';
import type { FlowProps } from './table/FlowControls';
import { ofcLedgerModel } from './ledger/model';
import { useTableState } from './useTableState';
import type { OfcSession } from './session';
import { ofcDeps, resumeOfcTable } from './session';
import type { OfcSnapshot } from './history';
import { describeRules } from './rules/describe';
import styles from '../backgammon/GameScreen.module.css';

interface Inflight {
  promise: Promise<OfcSession | null>;
  controller: AbortController;
  onProgress: ((p: FlowProgress) => void) | null;
  observers: number;
}
const inflightResumes = new Map<string, Inflight>();

function abortInflight(key: string): void {
  const entry = inflightResumes.get(key);
  if (!entry) return;
  inflightResumes.delete(key);
  entry.controller.abort();
}

export function progressText(p: FlowProgress | null): string {
  if (!p) return 'Looking for the other players under the saved room code.';
  const what =
    p.phase === 'hosting'
      ? 'Reopening the table'
      : p.phase === 'joining'
        ? 'Looking for the host'
        : 'Waiting for the host';
  const retry =
    p.nextRetryMs !== undefined ? ` · retrying in ${Math.ceil(p.nextRetryMs / 1000)} s` : '';
  return `${what}… attempt ${p.attempt}${retry}${p.lastError ? ` · ${p.lastError}` : ''}`;
}

export function GameScreen() {
  const { matchId } = useParams();
  const registry = useSessionRegistry();
  const { profile, slug, ready } = useProfile();
  const { path, id: gameId } = useGame();
  const existing = useSession<OfcSession>(slug, gameId, matchId);
  const navigate = useNavigate();

  const existingStatus = existing?.client.getState().status;
  const stale = !!existing && (existingStatus === 'disconnected' || existingStatus === 'rejected');
  useEffect(() => {
    if (stale && matchId) registry.remove(slug, gameId, matchId, true);
  }, [stale, matchId, registry, slug, gameId]);
  const session = stale ? undefined : existing;
  const leaving = useRef(false);
  type Resume = { status: 'loading' | 'missing' | 'error' | 'host-offline'; error?: string };
  const [resume, setResume] = useState<Resume>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const key = `${slug}:${gameId}:${matchId ?? ''}`;

  // A live session supersedes any attempt still in flight: a late-completing join must never
  // replace the table being played on (the registry refuses that too).
  useEffect(() => {
    if (session) abortInflight(key);
  }, [session, key]);

  useEffect(() => {
    if (session || !matchId || leaving.current) return;
    let entry = inflightResumes.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        const snapshot = await getSnapshotStore<OfcSnapshot>(slug, gameId).get(matchId);
        if (!snapshot) return null;
        const { profile, signer } = await ready();
        return resumeOfcTable(
          {
            snapshot,
            profile,
            signer: signer ?? undefined,
            randomness: randomnessFromSettings(getSettings(slug)),
          },
          {
            ...ofcDeps(slug),
            existingSession: (code) => registry.liveByCode(code) as OfcSession | undefined,
          },
          {
            signal: controller.signal,
            onProgress: (p) => inflightResumes.get(key)?.onProgress?.(p),
          },
        );
      })().finally(() => {
        if (inflightResumes.get(key)?.controller === controller) inflightResumes.delete(key);
      });
      entry = { promise, controller, onProgress: null, observers: 0 };
      inflightResumes.set(key, entry);
    }
    const mine = entry;
    mine.observers += 1;
    mine.onProgress = setProgress;
    let active = true;
    mine.promise.then(
      (s) => {
        if (s && !mine.controller.signal.aborted) registry.add(slug, gameId, s);
        else if (!s && active) setResume({ status: 'missing' });
      },
      (e) => {
        if (!active) return;
        if (e instanceof SessionError && e.code === 'cancelled') return;
        if (e instanceof SessionError && e.code === 'host-offline') {
          setResume({ status: 'host-offline', error: e.message });
        } else {
          setResume({
            status: 'error',
            error: e instanceof SessionError ? e.message : 'Could not reopen the table',
          });
        }
      },
    );
    return () => {
      active = false;
      mine.observers -= 1;
      if (mine.onProgress === setProgress) mine.onProgress = null;
      // Abort only when nobody observes the attempt any more (StrictMode re-mounts re-attach
      // before this fires, so a real unmount is what ends up cancelling).
      setTimeout(() => {
        if (mine.observers <= 0 && inflightResumes.get(key) === mine) abortInflight(key);
      }, 0);
    };
  }, [session, matchId, slug, gameId, ready, registry, attempt, key]);

  if (!matchId) return null;
  if (session) {
    return (
      <LiveTable
        session={session}
        onLeave={() => {
          leaving.current = true;
          registry.remove(slug, gameId, session.matchId, true);
          navigate(path('/'));
        }}
        onReconnect={() => {
          setResume({ status: 'loading' });
          setAttempt((n) => n + 1);
          registry.remove(slug, gameId, session.matchId, true);
        }}
      />
    );
  }

  const retry = () => {
    abortInflight(key);
    setProgress(null);
    setResume({ status: 'loading' });
    setAttempt((n) => n + 1);
  };
  const cancel = () => {
    leaving.current = true;
    abortInflight(key);
    navigate(path('/'));
  };

  return (
    <div className="page page-narrow">
      <div className={`card stack ${styles.center}`} data-testid="game-loading">
        {resume.status === 'loading' && (
          <>
            <span className="pulse" style={{ fontSize: '2rem' }}>
              🃏
            </span>
            <h2>{progress?.phase === 'waiting' ? 'Host is away' : 'Reopening the table…'}</h2>
            <p className="muted" data-testid="resume-progress" data-phase={progress?.phase ?? ''}>
              {progressText(progress)}
            </p>
            {progress?.phase === 'waiting' && (
              <p className="muted" data-testid="host-offline">
                {progress.lastError}. Only the host's browser holds the deck, so the table reopens
                when they do — this page keeps trying.
              </p>
            )}
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-sm" onClick={retry} data-testid="retry-resume">
                Retry now
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancel} data-testid="cancel-resume">
                Cancel
              </button>
            </div>
          </>
        )}
        {resume.status === 'host-offline' && (
          <>
            <span style={{ fontSize: '2rem' }}>⏳</span>
            <h2>Host is away</h2>
            <p className="muted" data-testid="host-offline">
              {resume.error}. Only the host's browser holds the deck, so the table reopens when they
              do.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={retry} data-testid="retry-resume">
                Try again
              </button>
              <button className="btn" onClick={cancel} data-testid="cancel-resume">
                Back home
              </button>
            </div>
          </>
        )}
        {resume.status === 'missing' && (
          <>
            <h2>Table not found</h2>
            <p className="muted">{profile.name} has no saved copy of that table in this browser.</p>
            <Link to={path('/')} className="btn btn-primary">
              Back home
            </Link>
          </>
        )}
        {resume.status === 'error' && (
          <>
            <h2>Could not reopen</h2>
            <p className="error-text" data-testid="resume-error">
              {resume.error}
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={retry}>
                Try again
              </button>
              <Link to={path('/')} className="btn">
                Back home
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type RailTab = 'match' | 'chat';

function statusText(
  t: TableView | null,
  mySeat: number | null,
  names: string[],
  seatsFilled: boolean,
): string {
  if (!t) return 'Connecting…';
  if (t.status === 'over') return 'Table closed';
  if (!seatsFilled) return 'Waiting for players to sit down';
  const hand = t.hand;
  if (!hand) return 'Ready to deal the first hand';
  if (hand.phase === 'showdown' || hand.phase === 'complete') return `Hand ${hand.number} scored`;
  const mine = mySeat === null ? null : hand.seats[mySeat];
  if (mine?.fantasyland && !mine.done && mine.pending.length > 0)
    return 'Set your Fantasyland hand';
  if (mySeat !== null && hand.toAct === mySeat) return 'Your turn to set';
  if (hand.toAct === null) return 'Waiting for Fantasyland hands';
  return `${names[hand.toAct] ?? `Seat ${hand.toAct + 1}`} is setting…`;
}

function dealerStatusText(
  t: TableView | null,
  names: string[],
  seatsFilled: boolean,
  auto: { on: boolean; ready: boolean[]; present: boolean[]; pending: { at: number } | null },
): string {
  if (!t) return 'Connecting…';
  if (t.status === 'over') return 'Table closed';
  const n = t.config.seats;
  const seatName = (i: number) => names[i] ?? `Seat ${i + 1}`;
  if (!seatsFilled) {
    return auto.on
      ? 'Waiting for players to sit down — the table deals itself'
      : 'Waiting for players to sit down';
  }
  const hand = t.hand;
  if (!hand)
    return auto.on ? 'Everyone is seated — dealing…' : 'Everyone is seated — deal the first hand';
  if (hand.phase === 'showdown' || hand.phase === 'complete') {
    if (!auto.on) return `Hand ${hand.number} scored — deal the next`;
    const away = Array.from({ length: n }, (_, i) => i).filter((i) => !auto.present[i]);
    if (away.length > 0)
      return `Hand ${hand.number} scored — waiting for ${away.map(seatName).join(', ')} to come back`;
    if (auto.pending)
      return `Hand ${hand.number} scored — next hand in ${Math.max(0, Math.ceil((auto.pending.at - Date.now()) / 1000))} s`;
    const readyCount = auto.ready.slice(0, n).filter(Boolean).length;
    return `Hand ${hand.number} scored — ${readyCount}/${n} ready for the next`;
  }
  if (hand.toAct !== null) return `${seatName(hand.toAct)} is setting…`;
  return 'Waiting for Fantasyland hands';
}

/** Unattended play is on for dealer-hosted tables unless switched off, and for players who opted in. */
function autopilotOn(
  snapshot: { options?: Record<string, unknown>; dealer?: unknown } | null,
): boolean {
  if (!snapshot) return false;
  const opt = snapshot.options?.autopilot;
  if (opt === true) return true;
  if (opt === false) return false;
  return !!snapshot.dealer;
}

function LiveTable({
  session,
  onLeave,
  onReconnect,
}: {
  session: OfcSession;
  onLeave: () => void;
  onReconnect: () => void;
}) {
  const client = session.client;
  const state = useTableState(client);
  const { reducedMotion } = useTheme();
  const toasts = useToasts();
  const landscape = useMediaQuery(LANDSCAPE_PHONE_QUERY);
  const [railTab, setRailTab] = useState<RailTab>('match');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  const seat = state.seat;
  const snapshot = state.snapshot;
  const role = state.role ?? 'seat';
  const isDealer = role === 'dealer';
  const dealerInfo =
    state.dealer ?? (snapshot?.dealer ? { profile: snapshot.dealer, connected: isDealer } : null);
  const names = useMemo(
    () => (snapshot?.seats ?? []).map((p, i) => p?.name ?? `Seat ${i + 1}`),
    [snapshot?.seats],
  );
  // The host holds the full state (deck included); everyone else already holds a view. The
  // table component always renders a view of the seat looking at it.
  const tableView = useMemo<TableView | null>(() => {
    if (!snapshot) return null;
    return snapshot.view
      ? (snapshot.state as TableView)
      : engineView(snapshot.state as unknown as TableState, seat ?? -1);
  }, [snapshot, seat]);
  const viewState = useMemo<TableClientState<TableView>>(
    () =>
      (snapshot && tableView
        ? { ...state, snapshot: { ...snapshot, state: tableView } }
        : state) as unknown as TableClientState<TableView>,
    [state, snapshot, tableView],
  );
  const send = (c: Command) => {
    client.send(c);
  };
  const seatsFilled = !!snapshot && snapshot.seats.every((s) => s !== null);
  const config: TableConfig | null = tableView?.config ?? null;
  const bal = tableView ? engineBalances(tableView as unknown as TableState) : [];

  // Error toasts from the server.
  const lastErrorAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.error && state.error.at !== lastErrorAt.current) {
      lastErrorAt.current = state.error.at;
      toasts.push(state.error.message, 'danger');
    }
  }, [state.error, toasts]);

  // Presence toasts per seat.
  const prevPresence = useRef<boolean[] | null>(null);
  useEffect(() => {
    const prev = prevPresence.current;
    const cur = state.presence;
    if (prev) {
      cur.forEach((online, i) => {
        if (i === seat || (prev[i] ?? false) === online) return;
        if (!snapshot?.seats[i]) return;
        toasts.push(
          online ? `${names[i]} joined` : `${names[i]} disconnected — the table is saved`,
          online ? 'success' : 'info',
        );
      });
    }
    prevPresence.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.presence]);

  // Hand results as toasts.
  const lastHand = useRef<number>(tableView?.history.length ?? 0);
  useEffect(() => {
    const n = tableView?.history.length ?? 0;
    if (n > lastHand.current && seat !== null) {
      const r = tableView!.history[n - 1]!.seats[seat];
      if (r) {
        toasts.push(
          r.fouled
            ? `Hand ${n}: you fouled (${r.points})`
            : `Hand ${n}: ${r.points > 0 ? '+' : ''}${r.points} points${r.royalties ? ` incl. ${r.royalties} royalties` : ''}`,
          r.points >= 0 ? 'success' : 'info',
        );
      }
    }
    lastHand.current = n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableView?.history.length]);

  const [readCount, setReadCount] = useState(0);
  const chatVisible = railTab === 'chat' && (!landscape || sheetOpen);
  const unread = chatVisible
    ? 0
    : state.chat.slice(readCount).filter((m) => m.seat !== seat).length;
  const openTab = (tab: RailTab) => {
    setRailTab(tab);
    if (tab === 'chat') setReadCount(state.chat.length);
  };

  const shortcuts = useMemo(
    () => ({
      escape: ledgerOpen
        ? () => setLedgerOpen(false)
        : sheetOpen
          ? () => setSheetOpen(false)
          : undefined,
    }),
    [ledgerOpen, sheetOpen],
  );
  useKeyboardShortcuts(shortcuts, state.status === 'joined');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === 'l' || e.key === 'L') setLedgerOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const auto = autopilotOn(snapshot);
  const flow: FlowProps | undefined = auto
    ? {
        autopilot: true,
        ready: state.ready,
        present: state.presence,
        resetRequests: tableView?.settleRequests ?? [],
        countdownAt: state.autopilot?.at ?? null,
        mySeat: isDealer ? null : seat,
        names,
        seatCount: snapshot?.seats.length ?? 0,
        setReady: (v) => client.setReady(v),
        requestReset: (v) => send({ type: 'settle-request', requested: v }),
      }
    : undefined;
  const status = isDealer
    ? dealerStatusText(tableView, names, seatsFilled, {
        on: auto,
        ready: state.ready,
        present: state.presence,
        pending: state.autopilot,
      })
    : statusText(tableView, seat, names, seatsFilled);
  const over = tableView?.status === 'over';
  const dealerCanDeal =
    isDealer &&
    !!tableView &&
    tableView.status !== 'over' &&
    seatsFilled &&
    (!tableView.hand || tableView.hand.phase === 'showdown');
  const fairnessSource = snapshot
    ? {
        id: snapshot.id,
        randomness: snapshot.options?.randomness as
          { provider: string; mode?: RandomnessMode } | undefined,
        actionMeta: snapshot.actionMeta,
        entropyAudit: snapshot.entropyAudit,
      }
    : null;

  const strip = tableView && snapshot && (
    <SeatStrip
      seats={snapshot.seats}
      presence={state.presence}
      mySeat={seat}
      hostSeat={snapshot.hostSeat ?? -1}
      toAct={tableView.hand?.phase === 'setting' ? tableView.hand.toAct : null}
      button={tableView.hand ? tableView.hand.button : tableView.button}
      scores={tableView.scores}
      balances={config?.scoring.mode === 'buyin' ? bal : undefined}
      fantasyland={tableView.fantasyland}
      inFantasyland={tableView.hand?.seats.map((s) => s.fantasyland)}
      latencyMs={session.role === 'guest' ? state.latencyMs : null}
      compact={landscape}
      dealer={dealerInfo ? { ...dealerInfo, me: isDealer } : null}
    />
  );

  const rail = (
    <>
      <div className={styles.railTabs} role="tablist">
        <button
          role="tab"
          aria-selected={railTab === 'match'}
          className={`${styles.railTab} ${railTab === 'match' ? styles.railTabActive : ''}`}
          onClick={() => openTab('match')}
          data-testid="rail-tab-match"
        >
          Table
        </button>
        <button
          role="tab"
          aria-selected={railTab === 'chat'}
          className={`${styles.railTab} ${railTab === 'chat' ? styles.railTabActive : ''}`}
          onClick={() => openTab('chat')}
          data-testid="rail-tab-chat"
        >
          Chat{unread > 0 ? ` (${unread})` : ''}
        </button>
      </div>
      <div className={`card ${styles.railCard} ${railTab !== 'match' ? styles.railHidden : ''}`}>
        <ClubChip />
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <TableConnectionBadge state={state} role={session.role} />
          <span className="badge" title="Room code">
            {session.code}
          </span>
        </div>
        {config && (
          <p className="muted small" data-testid="rules-summary">
            {describeRules(config)}
          </p>
        )}
        {dealerInfo && (
          <p className="small" data-testid="dealer-badge" data-connected={dealerInfo.connected}>
            🎩 Dealt by <strong>{dealerInfo.profile.name}</strong>
            {isDealer ? ' (you)' : dealerInfo.connected ? '' : ' · away'}
          </p>
        )}
        {state.snapshot && (
          <p className="small" data-testid="trust-line">
            <TrustBadge
              trust={
                (state.snapshot.options?.trust as TrustDescription | undefined) ??
                describeTrust(ofcDefinition, {
                  hostSeat: state.snapshot.hostSeat,
                  randomness: state.snapshot.options?.randomness as
                    { mode?: RandomnessMode; provider?: string } | undefined,
                })
              }
            />
          </p>
        )}
        {tableView && (
          <div className="stack-sm" data-testid="balances">
            {names.map((n, i) => (
              <div key={i} className="row" style={{ justifyContent: 'space-between' }}>
                <span>{n}</span>
                <span className="mono" data-testid={`balance-${i}`}>
                  {config?.scoring.mode === 'buyin'
                    ? bal[i]
                    : (tableView.scores[i] ?? 0) > 0
                      ? `+${tableView.scores[i]}`
                      : tableView.scores[i]}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn btn-sm"
            onClick={() => setLedgerOpen(true)}
            data-testid="ledger-button"
          >
            Ledger
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setFairnessOpen(true)}
            data-testid="fairness-button"
          >
            Fairness
          </button>
        </div>
        {!seatsFilled && (
          <>
            <hr className="divider" />
            <RoomCode code={session.code} />
          </>
        )}
        <hr className="divider" />
        <Handoff code={session.code} />
      </div>
      <div className={`card ${styles.railCard} ${railTab !== 'chat' ? styles.railHidden : ''}`}>
        <h3 style={{ marginBottom: 8 }}>Chat</h3>
        <TableChat
          chat={state.chat}
          mySeat={isDealer ? DEALER_SEAT : seat}
          names={names}
          dealerName={dealerInfo?.profile.name}
          disabled={state.status !== 'joined'}
          onSend={(t) => client.sendChat(t)}
        />
      </div>
      {!landscape && (
        <div className={styles.hint}>
          Shortcuts: <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> place on top / middle / bottom ·{' '}
          <kbd>⏎</kbd> confirm · <kbd>L</kbd> ledger · <kbd>Esc</kbd> close
        </div>
      )}
    </>
  );

  return (
    <div
      className={styles.screen}
      data-testid="game-screen"
      data-game="ofc"
      data-role={isDealer ? 'dealer' : session.role}
      data-seat={seat ?? ''}
      data-layout={landscape ? 'landscape' : 'default'}
      data-status={tableView?.status ?? ''}
    >
      {(state.status === 'disconnected' || state.status === 'rejected') && (
        <div className={styles.banner} role="alert" data-testid="disconnected-banner">
          <span>
            {state.status === 'rejected'
              ? 'The host turned this connection away.'
              : session.role === 'host'
                ? 'The table stopped. Your copy is saved.'
                : 'Connection to the host lost. The table is saved on their side.'}
          </span>
          <span className="row">
            <button
              className="btn btn-primary btn-sm"
              onClick={onReconnect}
              data-testid="reconnect-button"
            >
              Reconnect
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onLeave}>
              Leave
            </button>
          </span>
        </div>
      )}

      <div className={styles.opponentSlot}>{strip}</div>

      {landscape && (
        <div className={styles.sideStatus}>
          <span className={styles.sideStatusLine} data-testid="status-text">
            {status}
          </span>
        </div>
      )}

      <div className={styles.boardArea} data-testid="table-area">
        {tableView && (
          <OfcTable
            state={viewState}
            send={send}
            names={names}
            mySeat={seat}
            reducedMotion={reducedMotion}
            onOpenLedger={() => setLedgerOpen(true)}
            flow={flow}
          />
        )}
        {!seatsFilled && state.status === 'joined' && (
          <div className={styles.waiting}>
            <div className={`card ${styles.waitingCard}`}>
              <RoomCode code={session.code} />
            </div>
          </div>
        )}
        {over && tableView && (
          <div className={styles.waiting} data-testid="table-over">
            <div className={`card stack ${styles.waitingCard}`}>
              <div className="eyebrow">Table closed</div>
              <h2>Final balances</h2>
              {names.map((n, i) => (
                <div key={i} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{n}</span>
                  <span className="mono">
                    {config?.scoring.mode === 'buyin'
                      ? bal[i]
                      : (tableView.scores[i] ?? 0) > 0
                        ? `+${tableView.scores[i]}`
                        : tableView.scores[i]}
                  </span>
                </div>
              ))}
              <div className="row">
                <button className="btn btn-primary btn-sm" onClick={() => setLedgerOpen(true)}>
                  Ledger
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onLeave}>
                  Leave
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.mySlot} />

      <div className={styles.actions} data-testid={isDealer ? 'dealer-bar' : undefined}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          {!landscape && (
            <span className="muted small" data-testid="status-text">
              {status}
            </span>
          )}
          <span className="row">
            {isDealer && !auto && (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => send({ type: 'start' })}
                  disabled={!dealerCanDeal || state.status !== 'joined'}
                  data-testid="start-hand-button"
                >
                  {tableView?.hand ? 'Next hand' : 'Deal first hand'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setLedgerOpen(true)}
                  data-testid="settle-button"
                >
                  Settle
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setLedgerOpen(true)}
                  data-testid="adjust-button"
                >
                  Adjust
                </button>
              </>
            )}
            {isDealer && auto && (
              <details className={styles.advanced} data-testid="dealer-advanced">
                <summary className="btn btn-ghost btn-sm">Advanced</summary>
                <span className="row">
                  <button
                    className="btn btn-sm"
                    onClick={() => send({ type: 'start' })}
                    disabled={!dealerCanDeal || state.status !== 'joined'}
                    data-testid="start-hand-button"
                    title="The table deals by itself; this forces it now"
                  >
                    Deal now
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setLedgerOpen(true)}
                    data-testid="settle-button"
                  >
                    Scores
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setLedgerOpen(true)}
                    data-testid="adjust-button"
                  >
                    Adjust
                  </button>
                </span>
              </details>
            )}
            <button
              className="btn btn-sm"
              onClick={() => setLedgerOpen(true)}
              data-testid="ledger-button-bar"
            >
              Ledger
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setFairnessOpen(true)}
              data-testid="fairness-button-bar"
            >
              Fairness
            </button>
            {landscape && (
              <button
                className="btn btn-sm"
                onClick={() => setSheetOpen(true)}
                data-testid="more-button"
              >
                More
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={onLeave} data-testid="leave-button">
              Leave (resume later)
            </button>
          </span>
        </div>
      </div>

      {!landscape && (
        <aside className={styles.rail} data-testid="rail">
          {rail}
        </aside>
      )}

      {landscape && sheetOpen && (
        <div
          className={styles.sheet}
          data-testid="rail-sheet"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div className={styles.sheetCard} role="dialog" aria-label="Table details and chat">
            <div className={styles.sheetHeader}>
              <strong>Table</strong>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setSheetOpen(false)}
                data-testid="sheet-close"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {rail}
          </div>
        </div>
      )}

      {fairnessOpen && fairnessSource && snapshot && (
        <FairnessPanel
          source={fairnessSource}
          gameId="ofc"
          actions={snapshot.actions as unknown[]}
          seat={isDealer ? DEALER_SEAT : seat}
          exportName={`ofc-${session.code}-audit`}
          onClose={() => setFairnessOpen(false)}
        />
      )}
      {ledgerOpen && tableView && (
        <LedgerSheet
          model={ofcLedgerModel(tableView, names)}
          mySeat={seat}
          canSettle={state.status === 'joined'}
          onSettle={() => send({ type: 'settle' })}
          onAdjust={(s, points, note) => send({ type: 'adjust', seat: s, points, note })}
          resetRequests={tableView.settleRequests ?? []}
          onRequestReset={
            !isDealer && state.status === 'joined'
              ? (v) => send({ type: 'settle-request', requested: v })
              : undefined
          }
          onClose={() => setLedgerOpen(false)}
          exportName={`ofc-${session.code}-ledger`}
        />
      )}
    </div>
  );
}
