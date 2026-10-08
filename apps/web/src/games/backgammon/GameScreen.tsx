import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Player } from '@bgf/engine';
import { opponent } from '@bgf/engine';
import type { ClientState, GameClientApi } from '@bgf/client';
import type { Session } from '../../session/session';
import { resumeMatch, SessionError } from '../../session/session';
import { connLog } from '../../session/connLog';
import { CopyConnLog } from '../../hud/CopyConnLog';
import type { FlowProgress } from '../../session/retry';
import { getSettings } from '../../session/settings';
import { randomnessFromSettings } from '../../session/entropy';
import { FairnessPanel } from '../../hud/FairnessPanel';
import { TrustBadge } from '../../hud/TrustBadge';
import { describeTrust } from '@bgf/table';
import { backgammonDefinition } from '@bgf/server';
import { progressText } from '../ofc/GameScreen';
import { useSession, useSessionRegistry } from '../../session/SessionRegistry';
import { useClientState } from '../../session/useClientState';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { useSettings } from '../../session/settings';
import { getMatchStore } from '../../session/matchStore';
import { getProvider } from '../../session/providers';
import { LANDSCAPE_PHONE_QUERY, useMediaQuery } from '../../session/useMediaQuery';
import { useTheme } from '../../app/ThemeProvider';
import { Board2D } from '../../board/svg/Board2D';
import { useBoardViewModel } from '../../board/useBoardViewModel';
import { useBoardInteraction } from '../../board/useBoardInteraction';
import { PlayerCard } from '../../hud/PlayerCard';
import { ActionBar } from '../../hud/ActionBar';
import { LABEL_SIZES } from '../../board/geometry';
import { FullscreenIcon, useFullscreen } from '../../hud/useFullscreen';
import { MatchPanel } from '../../hud/MatchPanel';
import { Chat } from '../../hud/Chat';
import { RoomCode } from '../../hud/RoomCode';
import { Handoff } from '../../hud/Handoff';
import { ClubChip } from '../../clubs/ClubChip';
import { GameOverOverlay } from '../../hud/GameOverOverlay';
import { ConnectionBadge } from '../../hud/ConnectionBadge';
import { useToasts } from '../../hud/Toast';
import { useKeyboardShortcuts } from '../../hud/useKeyboardShortcuts';
import {
  canCommit,
  canDouble,
  canFreeRoll,
  canOpeningRoll,
  canRoll,
  canUndo,
  currentGame,
  gameOver,
  kindLabel,
  isFreeBoard,
  myTurn,
  opponentConnected,
  opponentPresent,
  pips,
  playerName,
  homeSideFor,
  isAutopilot,
  canStartGame,
} from '../../hud/derive';
import styles from './GameScreen.module.css';

interface Inflight {
  promise: Promise<Session | null>;
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

export function GameScreen() {
  const { matchId } = useParams();
  const registry = useSessionRegistry();
  const { profile, slug, ready } = useProfile();
  const { path, id: gameId } = useGame();
  const existing = useSession(slug, gameId, matchId);
  const navigate = useNavigate();

  // A session left behind by an earlier visit that has since disconnected is stale: drop it and
  // go through the resume flow (which re-hosts or re-joins as appropriate).
  const existingStatus = existing?.client.getState().status;
  const stale = !!existing && (existingStatus === 'disconnected' || existingStatus === 'rejected');
  useEffect(() => {
    if (stale && matchId) registry.remove(slug, gameId, matchId, true);
  }, [stale, matchId, registry, slug, gameId]);
  const session = stale ? undefined : existing;
  // Set when the player leaves on purpose: the session is gone but must not be resumed by the
  // effect below before navigation unmounts this screen (that would re-host the table here).
  const leaving = useRef(false);
  type Resume = { status: 'loading' | 'missing' | 'error'; error?: string };
  const [resume, setResume] = useState<Resume>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const key = `${slug}:${gameId}:${matchId ?? ''}`;

  // A live session supersedes any attempt still in flight: a late-completing join must never
  // replace the match being played on (the registry refuses that too).
  useEffect(() => {
    if (session) abortInflight(key);
  }, [session, key]);

  // Page refresh / deep link: rebuild the session from the saved snapshot. In-flight resumes are
  // deduplicated per match so StrictMode's double effects (and quick re-mounts) never race, and
  // they are aborted when this screen goes away for good.
  useEffect(() => {
    if (session || !matchId || leaving.current) return;
    let entry = inflightResumes.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        const snapshot = await getMatchStore(slug, gameId).get(matchId);
        if (!snapshot) return null;
        const { profile, signer } = await ready();
        return resumeMatch(
          {
            snapshot,
            profile,
            signer: signer ?? undefined,
            randomness: randomnessFromSettings(getSettings(slug)),
          },
          {
            provider: getProvider(slug, gameId),
            store: getMatchStore(slug, gameId),
            existingSession: (code) => registry.liveByCode(code) as Session | undefined,
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
        connLog('resume failed', { message: e instanceof Error ? e.message : String(e) });
        setResume({
          status: 'error',
          error: e instanceof SessionError ? e.message : 'Could not resume the match',
        });
      },
    );
    return () => {
      active = false;
      mine.observers -= 1;
      if (mine.onProgress === setProgress) mine.onProgress = null;
      setTimeout(() => {
        if (mine.observers <= 0 && inflightResumes.get(key) === mine) abortInflight(key);
      }, 0);
    };
  }, [session, matchId, slug, gameId, ready, registry, attempt, key]);

  const resumeState: Resume = resume;
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

  if (!matchId) return null;
  if (session) {
    return (
      <LiveGame
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

  return (
    <div className="page page-narrow">
      <div className={`card stack ${styles.center}`} data-testid="game-loading">
        {resumeState.status === 'loading' && (
          <>
            <span className="pulse" style={{ fontSize: '2rem' }}>
              🎲
            </span>
            <h2>{progress?.phase === 'waiting' ? 'Host is away' : 'Reopening the table…'}</h2>
            <p className="muted" data-testid="resume-progress" data-phase={progress?.phase ?? ''}>
              {progressText(progress)}
            </p>
            {progress?.phase === 'waiting' && (
              <p className="muted" data-testid="host-offline">
                {progress.lastError} — this page keeps trying.
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
            <CopyConnLog />
          </>
        )}
        {resumeState.status === 'missing' && (
          <>
            <h2>Match not found</h2>
            <p className="muted">{profile.name} has no saved copy of that match in this browser.</p>
            <Link to={path('/')} className="btn btn-primary">
              Back home
            </Link>
          </>
        )}
        {resumeState.status === 'error' && (
          <>
            <h2>Could not resume</h2>
            <p className="error-text" data-testid="resume-error">
              {resumeState.error}
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={retry} data-testid="retry-resume">
                Try again
              </button>
              <button className="btn" onClick={cancel} data-testid="cancel-resume">
                Back home
              </button>
            </div>
            <CopyConnLog />
          </>
        )}
      </div>
    </div>
  );
}

type RailTab = 'match' | 'chat';

/** Match panel, room code and chat: lives in the side rail on desktop and in a sheet on landscape phones. */
function RailContent({
  state,
  client,
  session,
  tab,
  onTab,
  unread,
  showHint,
  onFairness,
}: {
  state: ClientState;
  client: GameClientApi;
  session: Session;
  tab: RailTab;
  onTab: (t: RailTab) => void;
  unread: number;
  showHint: boolean;
  onFairness: () => void;
}) {
  const isDealer = (state.role ?? 'seat') === 'dealer';
  const dealerInfo =
    state.dealer ??
    (state.snapshot?.dealer ? { profile: state.snapshot.dealer, connected: isDealer } : null);
  const present = isDealer
    ? !!state.snapshot?.players.white && !!state.snapshot?.players.black
    : opponentPresent(state);
  return (
    <>
      <div className={styles.railTabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'match'}
          className={`${styles.railTab} ${tab === 'match' ? styles.railTabActive : ''}`}
          onClick={() => onTab('match')}
          data-testid="rail-tab-match"
        >
          Match
        </button>
        <button
          role="tab"
          aria-selected={tab === 'chat'}
          className={`${styles.railTab} ${tab === 'chat' ? styles.railTabActive : ''}`}
          onClick={() => onTab('chat')}
          data-testid="rail-tab-chat"
        >
          Chat{unread > 0 ? ` (${unread})` : ''}
        </button>
      </div>
      <div className={`card ${styles.railCard} ${tab !== 'match' ? styles.railHidden : ''}`}>
        <ClubChip />
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <ConnectionBadge state={state} role={session.role} />
          <span className="badge" title="Room code">
            {session.code}
          </span>
        </div>
        {dealerInfo && (
          <p className="small" data-testid="dealer-badge" data-connected={dealerInfo.connected}>
            🎩 Dealt by <strong>{dealerInfo.profile.name}</strong>
            {isDealer ? ' (you)' : dealerInfo.connected ? '' : ' · away'}
          </p>
        )}
        {state.snapshot && (
          <p className="small" data-testid="trust-line">
            <TrustBadge
              trust={describeTrust(backgammonDefinition, {
                hostSeat: state.snapshot.dealer ? null : 0,
                randomness: state.snapshot.randomness,
              })}
            />
          </p>
        )}
        <MatchPanel state={state} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm" onClick={onFairness} data-testid="fairness-button">
            Fairness
          </button>
        </div>
        {!present && (
          <>
            <hr className="divider" />
            <RoomCode code={session.code} />
          </>
        )}
        <hr className="divider" />
        <Handoff code={session.code} />
      </div>
      <div className={`card ${styles.railCard} ${tab !== 'chat' ? styles.railHidden : ''}`}>
        <h3 style={{ marginBottom: 8 }}>Chat</h3>
        <Chat state={state} client={client} />
      </div>
      {showHint && (
        <div className={styles.hint}>
          Shortcuts: <kbd>R</kbd> roll · <kbd>D</kbd> double · <kbd>⏎</kbd> done · <kbd>U</kbd> undo
          · <kbd>Esc</kbd> clear
        </div>
      )}
    </>
  );
}

function LiveGame({
  session,
  onLeave,
  onReconnect,
}: {
  session: Session;
  onLeave: () => void;
  onReconnect: () => void;
}) {
  const client = session.client;
  const state = useClientState(client);
  // A host that lost its room code to the other device rejoins them straight away: there is
  // nothing to wait for here, and the newer copy of the match wins when we say hello.
  const rejoined = useRef<object | null>(null);
  useEffect(() => {
    if (state.status !== 'disconnected' || !session.lostAddress) return;
    if (rejoined.current === session) return;
    rejoined.current = session;
    onReconnect();
  }, [state.status, session, onReconnect]);
  const [settings] = useSettings();
  const { theme, reducedMotion } = useTheme();
  const toasts = useToasts();
  const landscape = useMediaQuery(LANDSCAPE_PHONE_QUERY);
  const [railTab, setRailTab] = useState<RailTab>('match');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [overlayDismissedFor, setOverlayDismissedFor] = useState<number | null>(null);
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const isDealer = (state.role ?? 'seat') === 'dealer';

  const seat = state.seat;
  // Always from my own chair, my home board on the side I chose, whatever colour I play.
  // A dealer (no seat) sees the table as the host laid it out.
  const perspective: Player = seat ?? 'white';
  // Me on the left, always; a dealer (no seat) sees the board's near side on the left.
  const leftSeat: Player = seat ?? perspective;
  const rightSeat = opponent(leftSeat);
  const fullscreen = useFullscreen();

  const { interaction, handlers } = useBoardInteraction(client, state, seat);
  // One table: the host chose which side the home boards are on; the seat across sees the
  // mirror image. Viewing from `perspective` (flipped = the opponent's chair) keeps that true.
  const homeSide = seat ? settings.homeSidePreference : homeSideFor(state, perspective);

  // Point numbers: mine, or the opponent's (the mirror image) while I hold their card or, if I
  // chose so, while they are on turn. Releasing anywhere ends the hold.
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!peek) return;
    const end = () => setPeek(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
  }, [peek]);
  const turnPhase = state.snapshot?.match.game?.phase;
  const turnHolder =
    turnPhase && (turnPhase.kind === 'to-roll' || turnPhase.kind === 'moving')
      ? turnPhase.player
      : null;
  const numbering: Player | undefined = !seat
    ? undefined
    : peek || (settings.pointNumbering === 'mover' && turnHolder === opponent(seat))
      ? opponent(seat)
      : seat;
  const model = useBoardViewModel(state, {
    seat,
    perspective,
    interaction,
    homeSide,
  });
  const free = isFreeBoard(state);

  // Error toasts from the server.
  const lastErrorAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.error && state.error.at !== lastErrorAt.current) {
      lastErrorAt.current = state.error.at;
      toasts.push(state.error.message, 'danger');
    }
  }, [state.error, toasts]);

  // Presence toasts (for a seat; the dealer sees both seats' presence on their cards).
  const present = isDealer
    ? !!state.snapshot?.players.white && !!state.snapshot?.players.black
    : opponentPresent(state);
  const connected = isDealer
    ? state.presence.white && state.presence.black
    : opponentConnected(state);
  const prevConnected = useRef<boolean | null>(null);
  useEffect(() => {
    if (!present || isDealer) return;
    if (prevConnected.current === null) {
      prevConnected.current = connected;
      if (connected)
        toasts.push(`${playerName(state, opponent(seat ?? 'white'))} joined`, 'success', 2500);
      return;
    }
    if (prevConnected.current !== connected) {
      prevConnected.current = connected;
      toasts.push(
        connected
          ? `${playerName(state, opponent(seat ?? 'white'))} reconnected`
          : `${playerName(state, opponent(seat ?? 'white'))} disconnected — the match is saved`,
        connected ? 'success' : 'info',
        2500,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, connected]);

  // Chat unread badge: messages from the opponent since the chat tab was last opened.
  const [readCount, setReadCount] = useState(0);
  const chatVisible = railTab === 'chat' && (!landscape || sheetOpen);
  const unread = chatVisible
    ? 0
    : state.chat.slice(readCount).filter((m) => m.seat !== seat).length;
  const openTab = (tab: RailTab) => {
    setRailTab(tab);
    if (tab === 'chat') setReadCount(state.chat.length);
  };

  const clearSelection = useCallback(() => {
    if (interaction.selected) handlers.onSelect?.(interaction.selected);
  }, [interaction.selected, handlers]);

  // Tapping the cube (centred or mine, on my turn to roll) asks before doubling. The prompt
  // only shows while doubling is still possible, so it never outlives the chance.
  const mayDouble = canDouble(state);
  const [doubleAsked, setDoubleAsked] = useState(false);
  const doubleOpen = doubleAsked && mayDouble;

  const shortcuts = useMemo(
    () => ({
      roll: canOpeningRoll(state)
        ? () => client.openingRoll()
        : canRoll(state)
          ? () => client.roll()
          : canFreeRoll(state)
            ? () => client.freeRoll()
            : undefined,
      double: canDouble(state) ? () => client.double() : undefined,
      done: canCommit(state) ? () => client.commit() : undefined,
      undo: canUndo(state) ? () => client.unstage() : undefined,
      escape: doubleOpen
        ? () => setDoubleAsked(false)
        : sheetOpen
          ? () => setSheetOpen(false)
          : clearSelection,
    }),
    [state, client, clearSelection, sheetOpen, doubleOpen],
  );
  useKeyboardShortcuts(shortcuts, state.status === 'joined');

  const game = currentGame(state);
  const over = gameOver(state);
  const match = state.snapshot?.match ?? null;
  const gamesFinished = match?.games.length ?? 0;
  const showOverlay = !!over && overlayDismissedFor !== gamesFinished;
  const pc = pips(state);
  const onTurn = (s: Player) =>
    !!game &&
    game.phase.kind !== 'over' &&
    !free &&
    (seat === s ? myTurn(state) : !myTurn(state) && present);

  const cardFor = (s: Player, dock: 'left' | 'right') => (
    <PlayerCard
      dock={dock}
      onHoldStart={seat && s !== seat ? () => setPeek(true) : undefined}
      holding={peek && s !== seat}
      seat={s}
      name={playerName(state, s)}
      avatar={state.snapshot?.players[s]?.avatar}
      isMe={s === seat}
      present={isDealer ? !!state.snapshot?.players[s] : s === seat || present}
      connected={isDealer ? state.presence[s] : s === seat ? state.status === 'joined' : connected}
      score={match?.score[s] ?? 0}
      pips={pc[s]}
      onTurn={onTurn(s)}
      cubeValue={game && game.cube.owner === s ? game.cube.value : undefined}
      latencyMs={s === seat && session.role === 'guest' ? state.latencyMs : null}
    />
  );

  const fullscreenButton = (
    <button
      className="btn btn-ghost btn-sm btn-icon"
      onClick={fullscreen.toggle}
      data-testid="fullscreen-button"
      data-on={fullscreen.on ? 'true' : 'false'}
      aria-pressed={fullscreen.on}
      aria-label={fullscreen.on ? 'Exit full screen' : 'Full screen'}
      title={fullscreen.on ? 'Exit full screen' : 'Full screen'}
    >
      <FullscreenIcon on={fullscreen.on} />
    </button>
  );

  const rail = (
    <RailContent
      state={state}
      client={client}
      session={session}
      tab={railTab}
      onTab={openTab}
      unread={unread}
      showHint={!landscape}
      onFairness={() => setFairnessOpen(true)}
    />
  );

  return (
    <div
      className={styles.screen}
      data-testid="game-screen"
      data-role={isDealer ? 'dealer' : session.role}
      data-seat={seat ?? ''}
      data-layout={landscape ? 'landscape' : 'default'}
      data-rules={free ? 'free' : 'enforced'}
      data-staged={state.draft.played.length}
    >
      {(state.status === 'disconnected' || state.status === 'rejected') && (
        <div className={styles.banner} role="alert" data-testid="disconnected-banner">
          <span>
            {state.status === 'rejected'
              ? 'The host turned this connection away.'
              : 'Connection lost. Your progress is saved on both sides.'}
          </span>
          <span className="row">
            <button
              className="btn btn-primary btn-sm"
              onClick={onReconnect}
              data-testid="reconnect-button"
            >
              Reconnect
            </button>
            <CopyConnLog label="Copy log" />
            <button className="btn btn-ghost btn-sm" onClick={onLeave}>
              Leave
            </button>
          </span>
        </div>
      )}

      <div className={styles.boardArea} data-testid="board-area">
        <Board2D
          model={model}
          theme={theme}
          reducedMotion={reducedMotion}
          {...handlers}
          onCubeClick={mayDouble ? () => setDoubleAsked(true) : undefined}
          labelSize={LABEL_SIZES[settings.pointNumberSize]}
          numbering={numbering}
          centerOverlay={
            over && !showOverlay && state.seat ? (
              <div className={styles.resultBadge} data-testid="game-result" aria-live="polite">
                <strong className={over.winner === state.seat ? styles.resultWon : undefined}>
                  {over.winner === state.seat ? 'You won' : `${playerName(state, over.winner)} won`}
                </strong>
                <span>
                  {kindLabel(over.kind).toLowerCase()} · {over.points} pt
                  {over.points === 1 ? '' : 's'}
                </span>
              </div>
            ) : undefined
          }
        />
        {doubleOpen && (
          <div
            className={styles.confirmDoubleBackdrop}
            onClick={(e) => {
              if (e.target === e.currentTarget) setDoubleAsked(false);
            }}
          >
            <div
              className={`card ${styles.confirmDouble}`}
              role="dialog"
              aria-label="Offer a double"
              data-testid="double-confirm"
            >
              <strong>Offer a double?</strong>
              <span className="muted small">
                The cube goes to {(currentGame(state)?.cube.value ?? 1) * 2}.{' '}
                {playerName(state, opponent(seat ?? 'white'))} takes or drops.
              </span>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  className="btn btn-primary"
                  data-testid="confirm-double"
                  autoFocus
                  onClick={() => {
                    setDoubleAsked(false);
                    client.double();
                  }}
                >
                  Double
                </button>
                <button
                  className="btn btn-ghost"
                  data-testid="cancel-double"
                  onClick={() => setDoubleAsked(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {!present && state.status === 'joined' && (
          <div className={styles.waiting}>
            <div className={`card ${styles.waitingCard}`}>
              <RoomCode code={session.code} />
            </div>
          </div>
        )}
        {showOverlay && (
          <GameOverOverlay
            state={state}
            onNextGame={() => (isAutopilot(state) ? client.ready(true) : client.startGame())}
            onLeave={onLeave}
            onDismiss={() => setOverlayDismissedFor(gamesFinished)}
          />
        )}
      </div>

      {/* The dock: me on the left, the opponent on the right, what to do in the middle. */}
      <div className={styles.dock} data-testid="dock" data-dock>
        <div className={styles.dockLeft}>{cardFor(leftSeat, 'left')}</div>
        <div className={styles.dockCenter} data-testid={isDealer ? 'dealer-bar' : undefined}>
          {isDealer ? (
            <>
              <span className={styles.dealerStatus} data-testid="status-text">
                {!present
                  ? 'Waiting for both players to sit down'
                  : isAutopilot(state) && state.snapshot?.match.game?.phase.kind === 'over'
                    ? `Game over — next game when both are ready (${[state.ready?.white, state.ready?.black].filter(Boolean).length}/2)`
                    : `Dealing for ${playerName(state, 'white')} and ${playerName(state, 'black')}`}
              </span>
              <span className={styles.dealerButtons}>
                {isAutopilot(state) && (
                  <details className={styles.advanced} data-testid="dealer-advanced">
                    <summary className="btn btn-ghost btn-sm">Advanced</summary>
                    <button
                      className="btn btn-sm"
                      onClick={() => client.startGame()}
                      disabled={!canStartGame(state)}
                      data-testid="start-game-button"
                      title="The table starts games by itself; this forces it now"
                    >
                      Start now
                    </button>
                  </details>
                )}
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
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={onLeave}
                  data-testid="leave-button"
                >
                  Leave
                </button>
                {fullscreenButton}
              </span>
            </>
          ) : (
            <ActionBar
              state={state}
              client={client}
              onLeave={onLeave}
              compact={landscape}
              dense={landscape}
              onMore={landscape ? () => setSheetOpen(true) : undefined}
              // The result is shown over the board; the dock does not repeat it.
              showStatus={!over}
              fullscreen={fullscreen}
            />
          )}
          {!landscape && state.opponentPreview && state.opponentPreview.length > 0 && (
            <div className={styles.opponentPreview} data-testid="opponent-preview">
              {playerName(state, opponent(seat ?? 'white'))} is arranging a move…
            </div>
          )}
        </div>
        <div className={styles.dockRight}>{cardFor(rightSeat, 'right')}</div>
      </div>

      {!landscape && (
        <aside className={styles.rail} data-testid="rail">
          {rail}
        </aside>
      )}

      {fairnessOpen && state.snapshot && (
        <FairnessPanel
          source={state.snapshot}
          gameId="backgammon"
          actions={state.snapshot.actions}
          seat={isDealer ? -1 : seat === 'white' ? 0 : seat === 'black' ? 1 : null}
          exportName={`backgammon-${session.code}-audit`}
          onClose={() => setFairnessOpen(false)}
        />
      )}

      {landscape && sheetOpen && (
        <div
          className={styles.sheet}
          data-testid="rail-sheet"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div className={styles.sheetCard} role="dialog" aria-label="Match details and chat">
            <div className={styles.sheetHeader}>
              <strong>Match</strong>
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
    </div>
  );
}
