import { useEffect, useState } from 'react';
import styles from './OfcTable.module.css';

/** What an unattended table needs from the players between hands, and what it has scheduled. */
export interface FlowProps {
  /** The table runs itself (deals, next hand, score resets). */
  autopilot: boolean;
  /** Readiness by seat. */
  ready: boolean[];
  /** Live devices by seat. */
  present: boolean[];
  /** "Reset scores" requests by seat. */
  resetRequests: boolean[];
  /** Epoch ms of the scheduled next hand (countdown mode), or null. */
  countdownAt: number | null;
  mySeat: number | null;
  names: string[];
  seatCount: number;
  setReady: (ready: boolean) => void;
  requestReset: (requested: boolean) => void;
}

function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [at]);
  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Between hands on an unattended table: who is ready, who wants the scores reset, and when the
 * next hand deals. The dealer (no seat) sees the indicators only.
 */
export function FlowControls({ flow, over }: { flow: FlowProps; over: boolean }) {
  const seconds = useCountdown(flow.countdownAt);
  const seats = Array.from({ length: flow.seatCount }, (_, i) => i);
  const name = (i: number) => flow.names[i] ?? `Seat ${i + 1}`;
  const myReady = flow.mySeat !== null ? (flow.ready[flow.mySeat] ?? false) : false;
  const myReset = flow.mySeat !== null ? (flow.resetRequests[flow.mySeat] ?? false) : false;
  const absent = seats.filter((i) => !flow.present[i]);
  const notReady = seats.filter((i) => !flow.ready[i]);
  const wantReset = seats.filter((i) => flow.resetRequests[i]);
  const waitingReset = seats.filter((i) => !flow.resetRequests[i]);

  let status: string;
  if (over) status = 'The table is over.';
  else if (absent.length > 0) status = `Waiting for ${listNames(absent.map(name))} to come back…`;
  else if (seconds !== null) status = `Next hand in ${seconds} s`;
  else if (notReady.length === 0) status = 'Everyone is ready — dealing…';
  else status = `Waiting for ${listNames(notReady.map(name))} to be ready`;

  return (
    <div className={styles.flow} data-testid="flow-controls" data-countdown={seconds ?? ''}>
      <div className={styles.flowRow}>
        <span className={styles.flowStatus} data-testid="flow-status">
          {status}
        </span>
        {seconds !== null && (
          <span className={`badge ${styles.countdown}`} data-testid="next-hand-countdown">
            {seconds} s
          </span>
        )}
      </div>
      {!over && (
        <div className={styles.flowRow}>
          <div className={styles.readyChips} data-testid="ready-row">
            {seats.map((i) => (
              <span
                key={i}
                className={`badge ${flow.ready[i] ? 'badge-success' : ''} ${styles.readyChip}`}
                data-testid={`ready-${i}`}
                data-ready={flow.ready[i] ? 'true' : 'false'}
                data-present={flow.present[i] ? 'true' : 'false'}
              >
                {flow.ready[i] ? '✓' : '…'} {name(i)}
                {i === flow.mySeat ? ' (you)' : ''}
              </span>
            ))}
          </div>
          {flow.mySeat !== null && flow.countdownAt === null && (
            <button
              type="button"
              className={`btn btn-sm ${myReady ? '' : 'btn-primary'}`}
              onClick={() => flow.setReady(!myReady)}
              data-testid="ready-button"
              data-ready={myReady ? 'true' : 'false'}
            >
              {myReady ? 'Not ready' : "I'm ready"}
            </button>
          )}
        </div>
      )}
      <div className={styles.flowRow}>
        <span className="muted small" data-testid="settle-requests" data-count={wantReset.length}>
          {wantReset.length === 0
            ? 'Scores carry on until everyone asks to reset them.'
            : waitingReset.length === 0
              ? 'Everyone agreed — resetting the scores.'
              : `${listNames(wantReset.map(name))} ${wantReset.length === 1 ? 'wants' : 'want'} to reset the scores · waiting for ${listNames(waitingReset.map(name))}`}
        </span>
        {flow.mySeat !== null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => flow.requestReset(!myReset)}
            data-testid="settle-request-button"
            data-requested={myReset ? 'true' : 'false'}
          >
            {myReset ? 'Cancel reset' : 'Reset scores'}
          </button>
        )}
      </div>
    </div>
  );
}
