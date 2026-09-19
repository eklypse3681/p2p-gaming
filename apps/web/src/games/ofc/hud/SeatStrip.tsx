import type { PlayerProfile } from '@bgf/protocol';
import styles from './SeatStrip.module.css';

export interface SeatStripProps {
  seats: (PlayerProfile | null)[];
  presence: boolean[];
  mySeat: number | null;
  hostSeat: number;
  /** Seat that must act now (null while only Fantasyland seats remain, or between hands). */
  toAct: number | null;
  /** Seat holding the button for the current/next hand. */
  button: number | null;
  /** Net points per seat since the table started. */
  scores: number[];
  /** Displayed balances (buy-in mode) or undefined to show scores only. */
  balances?: number[];
  /** Fantasyland cards owed next hand per seat (0 = none). */
  fantasyland: number[];
  /** Seats currently in Fantasyland this hand. */
  inFantasyland?: boolean[];
  latencyMs?: number | null;
  compact?: boolean;
  /** Dealer-hosted tables: who deals, whether their device is connected, and whether that is us. */
  dealer?: { profile: PlayerProfile; connected: boolean; me: boolean } | null;
}

/** One card per seat: who sits there, whether they are online, the button, whose turn, scores. */
export function SeatStrip(p: SeatStripProps) {
  return (
    <div className={`${styles.strip} ${p.compact ? styles.compact : ''}`} data-testid="seat-strip">
      {p.dealer && (
        <div
          className={`${styles.seat} ${p.dealer.me ? styles.me : ''}`}
          data-testid="dealer-chip"
          data-connected={p.dealer.connected ? 'true' : 'false'}
        >
          <div className={styles.avatar} aria-hidden="true">
            {p.dealer.profile.avatar ?? '🎩'}
            <span
              className={`${styles.presence} ${p.dealer.connected ? styles.online : ''}`}
              title={p.dealer.connected ? 'Connected' : 'Offline'}
            />
          </div>
          <div className={styles.body}>
            <div className={styles.name}>
              {p.dealer.profile.name}
              {p.dealer.me && <span className="muted small"> (you)</span>}
              <span className="muted small" title="Deals, plays no seat">
                {' '}
                · dealer
              </span>
            </div>
            <div className={styles.meta}>
              <span className="muted small">Plays no seat</span>
            </div>
          </div>
        </div>
      )}
      {p.seats.map((profile, i) => {
        const me = i === p.mySeat;
        const present = profile !== null;
        const online = me || p.presence[i] === true;
        const active = p.toAct === i;
        const score = p.scores[i] ?? 0;
        return (
          <div
            key={i}
            className={`${styles.seat} ${active ? styles.active : ''} ${me ? styles.me : ''}`}
            data-testid={`seat-card-${i}`}
            data-to-act={active ? 'true' : 'false'}
            data-present={present ? 'true' : 'false'}
          >
            <div className={styles.avatar} aria-hidden="true">
              {present ? (profile.avatar ?? profile.name.slice(0, 1).toUpperCase()) : '…'}
              {present && (
                <span
                  className={`${styles.presence} ${online ? styles.online : ''}`}
                  title={online ? 'Connected' : 'Offline'}
                />
              )}
              {p.button === i && (
                <span className={styles.button} title="Button">
                  D
                </span>
              )}
            </div>
            <div className={styles.body}>
              <div className={styles.name} data-testid={`seat-name-${i}`}>
                {present ? profile.name : 'Open seat'}
                {me && <span className="muted small"> (you)</span>}
                {i === p.hostSeat && (
                  <span className="muted small" title="Runs the table">
                    {' '}
                    · host
                  </span>
                )}
              </div>
              <div className={styles.meta}>
                <span
                  className={`mono ${score > 0 ? styles.up : score < 0 ? styles.down : ''}`}
                  data-testid={`strip-score-${i}`}
                  title="Net points"
                >
                  {score > 0 ? `+${score}` : score}
                </span>
                {p.balances && (
                  <span className="mono muted" title="Balance">
                    · {p.balances[i] ?? 0}
                  </span>
                )}
                {(p.fantasyland[i] ?? 0) > 0 && (
                  <span className={styles.fl} title="Fantasyland next hand">
                    FL {p.fantasyland[i]}
                  </span>
                )}
                {p.inFantasyland?.[i] && (
                  <span className={styles.fl} title="In Fantasyland">
                    Fantasyland
                  </span>
                )}
                {active && <span className={styles.turn}>To act</span>}
                {me && p.latencyMs != null && (
                  <span className="mono muted" title="Round trip to host">
                    {p.latencyMs} ms
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
