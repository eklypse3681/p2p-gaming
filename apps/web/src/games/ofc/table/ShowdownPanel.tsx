import type { HandResult, Row } from '@bgf/ofc-engine';
import { ROWS, handSummary } from '@bgf/ofc-engine';
import type { SeatModel, TableModel } from './model';
import { ROW_LABELS, pairwiseFor, seatScooped, signed } from './model';
import { FlowControls } from './FlowControls';
import type { FlowProps } from './FlowControls';
import styles from './OfcTable.module.css';

export interface ShowdownPanelProps {
  model: TableModel;
  result: HandResult;
  onNextHand: () => void;
  onOpenLedger?: () => void;
  /** Unattended table: readiness / countdown / reset requests replace the "Next hand" button. */
  flow?: FlowProps;
}

function Cell({ points, bold, blank }: { points: number; bold?: boolean; blank?: boolean }) {
  return (
    <td
      className={`${styles.pairCell} ${bold ? styles.pairTotal : ''}`}
      data-points={points}
      data-sign={points > 0 ? 'pos' : points < 0 ? 'neg' : 'zero'}
    >
      {blank && points === 0 ? '' : signed(points)}
    </td>
  );
}

/** Fouled, scoop and next hand's Fantasyland for a seat. */
function seatBadges(result: HandResult, seat: number, scoop = seatScooped(result, seat)) {
  const s = result.seats[seat]!;
  return (
    <>
      {s.fouled && <span className={`${styles.badge} ${styles.badgeDanger}`}>fouled</span>}
      {scoop && <span className={`${styles.badge} ${styles.badgeFl}`}>scoop</span>}
      {s.fantasylandNext > 0 && (
        <span className={`${styles.badge} ${styles.badgeFl}`}>FL next · {s.fantasylandNext}</span>
      )}
    </>
  );
}

/** A seat's results against each other seat: one column per opponent, no words. */
function SeatBlock({
  seat,
  model,
  result,
  names,
  badgesFor,
}: {
  seat: SeatModel;
  model: TableModel;
  result: HandResult;
  names: string[];
  /** Two players: one box tells both sides, so the opponent's badges go in their column head. */
  badgesFor?: (seat: number) => React.ReactNode;
}) {
  const s = result.seats[seat.seat]!;
  const lines = pairwiseFor(result, seat.seat);
  const scoop = seatScooped(result, seat.seat);
  const running = model.balances[seat.seat] ?? seat.score;
  const runningText =
    model.config?.scoring.mode === 'buyin' ? `${running}` : signed(model.scores[seat.seat] ?? 0);
  return (
    <div
      className={styles.seatBlock}
      data-testid={`showdown-seat-${seat.seat}`}
      data-me={seat.isMe ? 'true' : 'false'}
      data-fouled={s.fouled ? 'true' : undefined}
    >
      <div className={styles.seatBlockHead}>
        <strong>
          {seat.name}
          {seat.isMe ? ' (you)' : ''}
        </strong>
        {seatBadges(result, seat.seat, scoop)}
        {/* This hand's points and the running total, in the head instead of a box of their own. */}
        <span
          className={styles.blockTotal}
          data-testid={`hand-total-${seat.seat}`}
          data-scoop={scoop ? 'true' : undefined}
          data-points={s.points}
        >
          <span
            className={styles.totalPoints}
            data-positive={s.points > 0 ? 'true' : undefined}
            data-negative={s.points < 0 ? 'true' : undefined}
          >
            {signed(s.points)}
          </span>
          <span className={styles.hiddenNote}>
            {model.config?.scoring.mode === 'buyin' ? 'balance' : 'running'} {runningText}
          </span>
        </span>
      </div>
      <table className={styles.pairs}>
        <thead>
          <tr>
            <th />
            {lines.map((l) => (
              <th key={l.opponent} data-testid={`pair-${seat.seat}-vs-${l.opponent}`}>
                vs {names[l.opponent] ?? `Seat ${l.opponent + 1}`}
                {badgesFor?.(l.opponent)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row: Row) => (
            <tr key={row}>
              <th>{ROW_LABELS[row]}</th>
              {lines.map((l) => (
                <Cell key={l.opponent} points={l.rows[row]} />
              ))}
            </tr>
          ))}
          <tr>
            <th className={s.fouled ? styles.struck : undefined}>Royalties</th>
            {lines.map((l) => (
              <Cell key={l.opponent} points={l.royalties} />
            ))}
          </tr>
          <tr>
            <th>Scoop</th>
            {lines.map((l) => (
              <Cell key={l.opponent} points={l.scoop} blank />
            ))}
          </tr>
          <tr className={styles.pairTotalRow}>
            <th>Total</th>
            {lines.map((l) => (
              <Cell key={l.opponent} points={l.total} bold />
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Pairwise results per seat (the viewer first), hand totals, and the summary lines. */
export function ShowdownPanel({
  model,
  result,
  onNextHand,
  onOpenLedger,
  flow,
}: ShowdownPanelProps) {
  const bySeat = model.seats.slice().sort((a, b) => a.seat - b.seat);
  const names = bySeat.map((s) => s.name);
  const lines = handSummary(result, names);
  const over = model.phase === 'over' || model.phase === 'complete';
  const me = bySeat.find((s) => s.isMe);
  const ordered = me ? [me, ...bySeat.filter((s) => !s.isMe)] : bySeat;
  return (
    <div className={styles.showdown} data-testid="showdown-panel" role="status">
      <div className={styles.showdownHead}>
        <strong>Hand {result.hand} · showdown</strong>
        <div className={styles.headerActions}>
          {onOpenLedger && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onOpenLedger}
              data-testid="open-ledger"
            >
              Ledger
            </button>
          )}
          {!over && !flow?.autopilot && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onNextHand}
              data-testid="start-hand-button"
            >
              Next hand
            </button>
          )}
        </div>
      </div>
      {flow?.autopilot && <FlowControls flow={flow} over={over} />}
      {/* Two players tell one story from two sides: one box (mine). Three get one box each. */}
      <div className={styles.seatBlocks}>
        {(bySeat.length === 2 ? ordered.slice(0, 1) : ordered).map((seat) => (
          <SeatBlock
            key={seat.seat}
            seat={seat}
            model={model}
            result={result}
            names={names}
            badgesFor={
              bySeat.length === 2 ? (other) => <> {seatBadges(result, other)}</> : undefined
            }
          />
        ))}
      </div>
      <ul className={styles.summary} data-testid="hand-summary">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {model.bust && (
        <div className={styles.bust} data-testid="bust-note">
          A seat is out of points: the table is over. Settle up from the ledger.
        </div>
      )}
    </div>
  );
}
