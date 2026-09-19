import { useEffect, useMemo, useState } from 'react';
import type { ClubCurrency, LobbyState } from '@bgf/protocol';
import type { MatchCriteria } from '@bgf/club-spec';
import { getGame } from '../games/registry';
import { formatChips, parseChips } from './money';
import type { ClubClientApi, ClubClientState } from './types';
import styles from './clubs.module.css';

/**
 * Find a game: say what you are willing to play and let the club seat you.
 *
 * The queue is the club's front door — on the public play-money club it is how most people
 * start a game at all, rather than browsing tables. While queued we show what the club tells
 * us (depth, its own estimate) plus an elapsed timer of our own, because a wait with no visible
 * progress is the thing people abandon.
 */

function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function waitText(ms: number): string {
  if (ms < 45_000) return `about ${Math.max(5, Math.round(ms / 5000) * 5)} seconds`;
  return `about ${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

export interface FindGameProps {
  client: ClubClientApi | null;
  state: ClubClientState | null;
  lobby: LobbyState | null;
  currency: ClubCurrency;
  /** Called with the ticket whenever we join or leave the queue, so it can be remembered. */
  onQueueChange?: (criteria: MatchCriteria | null) => void;
}

export function FindGame({ client, state, lobby, currency, onQueueChange }: FindGameProps) {
  const templates = useMemo(() => lobby?.rooms.flatMap((r) => r.templates) ?? [], [lobby]);
  const games = useMemo(() => {
    const ids = new Set(templates.map((t) => t.game));
    return Array.from(ids);
  }, [templates]);
  const seatOptions = useMemo(() => {
    const sizes = new Set(templates.map((t) => t.seats));
    return Array.from(sizes).sort((a, b) => a - b);
  }, [templates]);

  // Derived rather than synced: the default is simply "the first game this club offers".
  const [picked, setGame] = useState<string | null>(null);
  const [seats, setSeats] = useState<number[]>([]);
  const [maxStake, setMaxStake] = useState('');
  const [allowSoftware, setAllowSoftware] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const game = picked ?? games[0] ?? '';

  const ticket = state?.ticket ?? null;

  // A visible clock while queued; nothing ticking when idle.
  useEffect(() => {
    if (!ticket) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticket]);

  const queue = () => {
    if (!client || !game) return;
    const stakeCap = maxStake ? parseChips(maxStake, currency) : null;
    const criteria: MatchCriteria = {
      game,
      ...(seats.length ? { seats } : {}),
      ...(stakeCap !== null ? { stakes: { max: stakeCap } } : {}),
      allowSoftware,
    };
    client.queue(criteria);
    onQueueChange?.(criteria);
  };

  const cancel = () => {
    if (!client) return;
    client.unqueue(ticket?.id);
    onQueueChange?.(null);
  };

  if (ticket) {
    const estimate = ticket.estimate;
    return (
      <section className="card" data-testid="find-game" data-queued="true">
        <h2>Looking for a game</h2>
        <div className={styles.queue}>
          <span className={styles.queueSpinner} aria-hidden="true" />
          <div>
            <div data-testid="queue-status">
              {getGame(ticket.criteria.game)?.name ?? ticket.criteria.game}
              {ticket.criteria.seats?.length
                ? ` · ${ticket.criteria.seats.join(' or ')} seats`
                : ''}
            </div>
            <div className="muted small">
              <span data-testid="queue-elapsed">{elapsedText(now - ticket.queuedAt)}</span>
              {estimate?.queueDepth !== undefined && (
                <>
                  {' · '}
                  <span data-testid="queue-depth">{estimate.queueDepth} waiting</span>
                </>
              )}
              {estimate?.waitMs !== undefined && <> · {waitText(estimate.waitMs)}</>}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={cancel} data-testid="cancel-queue">
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card" data-testid="find-game" data-queued="false">
      <h2>Find a game</h2>
      <p className="muted small">
        Tell the club what you will play and it seats you as soon as enough people want the same
        thing.
      </p>
      {state?.queueEnded && state.queueEnded.reason !== 'matched' && (
        <p className="muted small" role="status" data-testid="queue-ended">
          {state.queueEnded.reason === 'member'
            ? 'You left the queue.'
            : state.queueEnded.reason === 'expired'
              ? 'The queue timed out. Try again.'
              : 'The club ended the queue.'}
        </p>
      )}
      <div className={styles.criteria}>
        <div className={styles.criteriaRow} role="group" aria-label="Game">
          {games.map((g) => (
            <button
              key={g}
              type="button"
              className={`btn btn-sm ${game === g ? 'btn-primary' : ''}`}
              aria-pressed={game === g}
              onClick={() => setGame(g)}
              data-testid={`criteria-game-${g}`}
            >
              <span aria-hidden="true">{getGame(g)?.icon ?? '🎴'}</span> {getGame(g)?.name ?? g}
            </button>
          ))}
        </div>
        {seatOptions.length > 1 && (
          <div className={styles.criteriaRow} role="group" aria-label="Table size">
            {seatOptions.map((n) => {
              const on = seats.includes(n);
              return (
                <button
                  key={n}
                  type="button"
                  className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                  aria-pressed={on}
                  onClick={() =>
                    setSeats(
                      on ? seats.filter((s) => s !== n) : [...seats, n].sort((a, b) => a - b),
                    )
                  }
                  data-testid={`criteria-seats-${n}`}
                >
                  {n} players
                </button>
              );
            })}
          </div>
        )}
        <div className={styles.criteriaRow}>
          <label className="muted small" htmlFor="criteria-stakes">
            Up to
          </label>
          <input
            id="criteria-stakes"
            className="input"
            style={{ width: 120 }}
            placeholder="any stake"
            aria-label="Maximum stake per point"
            value={maxStake}
            onChange={(e) => setMaxStake(e.target.value)}
            data-testid="criteria-stakes"
          />
          <span className="muted small">{currency.code} per point</span>
        </div>
        <label className={styles.criteriaRow}>
          <input
            type="checkbox"
            checked={allowSoftware}
            onChange={(e) => setAllowSoftware(e.target.checked)}
            data-testid="criteria-software"
          />
          <span className="muted small">Software opponents are fine</span>
        </label>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!client || !game}
        onClick={queue}
        data-testid="queue-button"
      >
        Find a game
      </button>
      {state?.balance !== null && state?.balance !== undefined && (
        <span className="muted small" style={{ marginLeft: '0.5rem' }}>
          {formatChips(state.balance, currency)} available
        </span>
      )}
    </section>
  );
}
