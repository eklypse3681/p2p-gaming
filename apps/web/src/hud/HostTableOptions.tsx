import { useState } from 'react';
import type { RandomnessChoice } from '../session/entropy';
import { describeRandomness, randomnessProblem, randomnessSafety } from '../session/entropy';
import { randomnessFromSettings } from '../session/entropy';
import { useSettings } from '../session/settings';
import { RandomnessControls } from './RandomnessControls';
import styles from './HostTableOptions.module.css';

export interface HostTableChoice {
  /** Host as a non-playing dealer. */
  dealer: boolean;
  /** Randomness for this table (starts from the player's defaults). */
  randomness: RandomnessChoice;
  /** Deal by hand instead of letting the table run itself (unattended is the default). */
  manualDealing: boolean;
}

/** Initial host choices for a player: their settings defaults, not dealing. */
export function useHostTableChoice(): [HostTableChoice, (next: HostTableChoice) => void] {
  const [settings] = useSettings();
  const [choice, setChoice] = useState<HostTableChoice>(() => ({
    dealer: false,
    randomness: randomnessFromSettings(settings),
    manualDealing: false,
  }));
  return [choice, setChoice];
}

export interface HostTableOptionsProps {
  value: HostTableChoice;
  onChange: (next: HostTableChoice) => void;
  /** Copy for the dealer toggle's explanation. */
  dealerHelp: string;
}

/**
 * The "Table" block of a host screen: the randomness the table will use (a summary chip with a
 * per-table override) and whether the host plays or deals.
 */
export function HostTableOptions({ value, onChange, dealerHelp }: HostTableOptionsProps) {
  const [open, setOpen] = useState(false);
  const problem = randomnessProblem(value.randomness);
  const safety = randomnessSafety(value.randomness, value.dealer);
  return (
    <div className="field" data-testid="host-table-options">
      <span className="label">Table</span>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Randomness</span>
        <span
          className={`badge ${safety === 'safe' ? 'badge-success' : safety === 'trusted-host' ? 'badge-danger' : ''}`}
          data-testid="host-randomness-summary"
          data-safety={safety}
        >
          {describeRandomness(value.randomness)}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="host-randomness-change"
        >
          {open ? 'Done' : 'Change'}
        </button>
      </div>
      {!open && problem && (
        <p className="error-text small" role="alert" data-testid="host-randomness-problem-summary">
          {problem} — open “Change” to fix it.
        </p>
      )}
      {open && (
        <div className={styles.override} data-testid="host-randomness-override">
          <RandomnessControls
            value={value.randomness}
            onChange={(randomness) => onChange({ ...value, randomness })}
            idPrefix="host-"
            dealer={value.dealer}
          />
        </div>
      )}
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={value.dealer}
          onChange={(e) => onChange({ ...value, dealer: e.target.checked })}
          data-testid="host-as-dealer"
        />
        <span className={styles.toggleText}>
          Host as dealer (I won’t play)
          <small>{dealerHelp}</small>
        </span>
      </label>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={value.manualDealing}
          onChange={(e) => onChange({ ...value, manualDealing: e.target.checked })}
          data-testid="manual-dealing"
        />
        <span className={styles.toggleText}>
          Manual dealing
          <small>
            Off (default): the table runs itself — it deals when every seat is taken, moves on when
            everyone is ready and resets scores when everyone agrees. On: you press the buttons.
          </small>
        </span>
      </label>
    </div>
  );
}
