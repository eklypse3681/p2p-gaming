import type { ClientState } from '@bgf/client';
import { canStartGame, currentMatch, gameOver, kindLabel, playerName } from './derive';
import styles from './GameOverOverlay.module.css';

export interface GameOverOverlayProps {
  state: ClientState;
  onNextGame: () => void;
  onLeave: () => void;
  onDismiss: () => void;
}

export function GameOverOverlay({ state, onNextGame, onLeave, onDismiss }: GameOverOverlayProps) {
  const result = gameOver(state);
  const m = currentMatch(state);
  if (!result || !m || !state.seat) return null;
  const won = result.winner === state.seat;
  const winnerName = playerName(state, result.winner);
  const how =
    result.how === 'drop'
      ? 'by dropping the cube'
      : result.how === 'resign'
        ? 'by resignation'
        : result.how === 'recorded'
          ? `— ${kindLabel(result.kind).toLowerCase()}, recorded by hand`
          : `— ${kindLabel(result.kind).toLowerCase()}`;
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-over-title"
      data-testid="game-over"
    >
      <div className={`card ${styles.card}`}>
        <div className="eyebrow">{m.winner ? 'Match over' : `Game ${m.games.length}`}</div>
        <h2 id="game-over-title" className={`${styles.title} ${won ? styles.won : ''}`}>
          {m.winner
            ? m.winner === state.seat
              ? 'You won the match!'
              : `${winnerName} wins the match`
            : won
              ? 'You won!'
              : `${winnerName} wins`}
        </h2>
        <div className={styles.detail}>
          {result.points} point{result.points === 1 ? '' : 's'} {how}
          {result.cube > 1 ? ` · cube at ${result.cube}` : ''}
        </div>
        <div className={styles.score} data-testid="game-over-score">
          {playerName(state, 'white')} {m.score.white} — {m.score.black}{' '}
          {playerName(state, 'black')}
        </div>
        {m.config.length > 0 && !m.winner && (
          <div className="muted small">First to {m.config.length}</div>
        )}
        <div className={styles.actions}>
          {m.winner ? (
            <button className="btn btn-primary" onClick={onLeave} data-testid="back-home-button">
              Back to home
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={onNextGame}
              disabled={!canStartGame(state)}
              data-testid="start-game-button"
            >
              Next game
            </button>
          )}
          <button className="btn btn-ghost" onClick={onDismiss} data-testid="game-over-dismiss">
            View board
          </button>
        </div>
      </div>
    </div>
  );
}
