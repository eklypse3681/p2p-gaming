import type { ClientState } from '@bgf/client';
import { currentGame, currentMatch, describeConfig, pips, playerName } from './derive';
import styles from './MatchPanel.module.css';

export function MatchPanel({ state }: { state: ClientState }) {
  const m = currentMatch(state);
  const g = currentGame(state);
  if (!m) return null;
  const pc = pips(state);
  const cubeOwner = g?.cube.owner === 'center' || !g ? 'Centred' : playerName(state, g.cube.owner);
  return (
    <div className={styles.panel} data-testid="match-panel">
      <div className={styles.scoreRow}>
        <div className={styles.side}>
          <span className={styles.name}>{playerName(state, 'white')}</span>
          <span className={styles.big} data-testid="score-white">
            {m.score.white}
          </span>
        </div>
        <span className={styles.vs}>VS</span>
        <div className={`${styles.side} ${styles.sideRight}`}>
          <span className={styles.name}>{playerName(state, 'black')}</span>
          <span className={styles.big} data-testid="score-black">
            {m.score.black}
          </span>
        </div>
      </div>
      <div className={styles.badges}>
        <span className="badge">{describeConfig(m)}</span>
        {g?.crawford && (
          <span className="badge badge-outline-accent" title="No doubling this game">
            Crawford
          </span>
        )}
        {m.winner && <span className="badge badge-accent">Match over</span>}
        {g && !m.winner && <span className="badge">Game {m.games.length + 1}</span>}
      </div>
      <div className={styles.grid}>
        <span className={styles.k}>Cube</span>
        <span className={styles.v} data-testid="cube-info">
          {g ? g.cube.value : 1} · {cubeOwner}
        </span>
        <span className={styles.k}>Pips {playerName(state, 'white')}</span>
        <span className={styles.v} data-testid="pips-white">
          {pc.white}
        </span>
        <span className={styles.k}>Pips {playerName(state, 'black')}</span>
        <span className={styles.v} data-testid="pips-black">
          {pc.black}
        </span>
        {g && (
          <>
            <span className={styles.k}>Turn</span>
            <span className={styles.v}>{g.turnCount}</span>
          </>
        )}
      </div>
    </div>
  );
}
