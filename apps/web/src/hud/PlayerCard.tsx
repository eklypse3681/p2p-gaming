import type { Player } from '@bgf/engine';
import styles from './PlayerCard.module.css';

export interface PlayerCardProps {
  seat: Player;
  name: string;
  avatar?: string;
  isMe: boolean;
  connected: boolean;
  present: boolean;
  score: number;
  pips: number;
  onTurn: boolean;
  cubeValue?: number;
  latencyMs?: number | null;
  /** Narrow, stacked layout for the landscape side column. */
  compact?: boolean;
  /** Small card for the bottom dock; `right` mirrors it so the score sits on the outer edge. */
  dock?: 'left' | 'right';
}

export function PlayerCard(p: PlayerCardProps) {
  // Here, away (seated but their device dropped) or not here yet (nobody in the seat).
  const presence = !p.present ? 'empty' : p.connected ? 'here' : 'away';
  return (
    <div
      className={`${styles.card} ${presence === 'away' ? styles.away : ''} ${presence === 'empty' ? styles.empty : ''} ${p.onTurn ? styles.active : ''} ${p.compact ? styles.compact : ''} ${p.dock ? styles.dock : ''} ${p.dock === 'right' ? styles.dockRight : ''}`}
      data-testid={`player-card-${p.seat}`}
      data-on-turn={p.onTurn ? 'true' : 'false'}
      data-presence={presence}
      title={presence === 'away' ? `${p.name} is away` : undefined}
    >
      <div className={styles.avatar} aria-hidden="true">
        {p.present ? (p.avatar ?? p.name.slice(0, 1).toUpperCase()) : '…'}
        <span
          className={`${styles.checker} ${p.seat === 'white' ? styles.checkerWhite : styles.checkerBlack}`}
        />
        {p.present && (
          <span
            className={`${styles.presence} ${p.connected ? styles.online : ''}`}
            title={p.connected ? 'Connected' : 'Offline'}
          />
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.name} data-testid={`player-name-${p.seat}`}>
          {p.present ? p.name : 'Waiting for opponent'}
          {p.isMe && <span className="muted small"> (you)</span>}
        </div>
        <div className={styles.meta}>
          {presence !== 'here' && (
            <span className={styles.presenceTag} data-testid={`presence-${p.seat}`}>
              {presence === 'away' ? 'Away' : 'Not here yet'}
            </span>
          )}
          <span className={styles.pips} data-testid={`card-pips-${p.seat}`} title="Pip count">
            {p.pips}
            <span className={styles.pipsUnit}> pips</span>
          </span>
          {p.cubeValue !== undefined && (
            <span className={styles.cube} title="Owns the cube">
              ×{p.cubeValue}
            </span>
          )}
          {p.onTurn && !p.dock && <span className={styles.turn}>On turn</span>}
          {p.isMe && p.latencyMs != null && (
            <span className="mono" title="Round trip to host">
              {p.latencyMs} ms
            </span>
          )}
        </div>
      </div>
      <div
        className={styles.score}
        data-testid={`card-score-${p.seat}`}
        aria-label={`${p.name} score`}
      >
        {p.score}
      </div>
    </div>
  );
}
