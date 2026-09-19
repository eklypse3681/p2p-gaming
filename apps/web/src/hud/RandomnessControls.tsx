import type { RandomnessMode } from '@bgf/protocol';
import type { EntropySourceId } from '../session/settings';
import type { RandomnessChoice } from '../session/entropy';
import { randomnessProblem, randomnessSafety, safetyText } from '../session/entropy';
import styles from './RandomnessControls.module.css';

const SOURCES: { id: EntropySourceId; testId: string; title: string; text: string }[] = [
  {
    id: 'crypto',
    testId: 'crypto',
    title: 'This device',
    text: 'The browser’s own generator. Fast and private, but nobody else can check it.',
  },
  {
    id: 'random.org',
    testId: 'random-org',
    title: 'random.org',
    text: 'Signed true randomness. Needs a free API key; every draw carries a signature anyone can verify.',
  },
  {
    id: 'drand',
    testId: 'drand',
    title: 'drand beacon',
    text: 'The League of Entropy’s public beacon, a new value every 3 s. No key; rounds are verifiable.',
  },
];

const MODES: { id: RandomnessMode; title: string; text: string }[] = [
  {
    id: 'per-draw',
    title: 'Per draw',
    text: 'Each roll or deal fetches fresh randomness at that moment. Nobody knows a value early.',
  },
  {
    id: 'seeded',
    title: 'Seeded',
    text: 'One seed per hand or game, committed first and revealed at the end so everyone can re-derive every draw. The host knows the seed while the hand is played.',
  },
  {
    id: 'beacon',
    title: 'Beacon',
    text: 'Each draw is bound to the next drand round before that round exists. Slower (≈3 s per draw), strongest guarantee. Needs drand.',
  },
];

export interface RandomnessControlsProps {
  value: RandomnessChoice;
  onChange: (next: RandomnessChoice) => void;
  /** Prefix for test ids (`host-` on the host screen, none in Settings). */
  idPrefix?: string;
  /** Whether the table will be dealer-hosted (changes the safety note). */
  dealer?: boolean;
  /** Show the fallback toggle. Default true. */
  showFallback?: boolean;
  /** random.org bookkeeping to show, when known. */
  requestsLeft?: number | null;
}

/** Source and mode pickers with plain-language help; shared by Settings and the host screens. */
export function RandomnessControls({
  value,
  onChange,
  idPrefix = '',
  dealer = false,
  showFallback = true,
  requestsLeft = null,
}: RandomnessControlsProps) {
  const problem = randomnessProblem(value);
  const safety = randomnessSafety(value, dealer);
  const beaconDisabled = value.source !== 'drand';
  return (
    <div className={styles.controls} data-testid={`${idPrefix}randomness-controls`}>
      <div className="field">
        <span className="label">Source</span>
        <div className={styles.cards} role="radiogroup" aria-label="Randomness source">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={value.source === s.id}
              className={`${styles.card} ${value.source === s.id ? styles.cardActive : ''}`}
              onClick={() => {
                const next = { ...value, source: s.id };
                if (next.mode === 'beacon' && s.id !== 'drand') next.mode = 'per-draw';
                onChange(next);
              }}
              data-testid={`${idPrefix}source-${s.testId}`}
            >
              <strong>{s.title}</strong>
              <small>{s.text}</small>
            </button>
          ))}
        </div>
        {value.source === 'random.org' && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="label" htmlFor={`${idPrefix}random-org-key`}>
              random.org API key
            </label>
            <input
              id={`${idPrefix}random-org-key`}
              className="input mono"
              type="password"
              autoComplete="off"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={value.randomOrgKey}
              onChange={(e) => onChange({ ...value, randomOrgKey: e.target.value })}
              data-testid={`${idPrefix}random-org-key`}
            />
            <span className="help">
              Stored only in this browser and used only when you host.{' '}
              <a href="https://api.random.org/api-keys/beta" target="_blank" rel="noreferrer">
                Get a free key
              </a>
              . The free tier allows 1,000 signed requests a day; a Pineapple hand for three uses
              about 13.
              {requestsLeft !== null && (
                <span data-testid={`${idPrefix}requests-left`}>
                  {' '}
                  Requests left today: {requestsLeft}.
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="field">
        <span className="label">Mode</span>
        <div className={styles.cards} role="radiogroup" aria-label="Randomness mode">
          {MODES.map((m) => {
            const disabled = m.id === 'beacon' && beaconDisabled;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={value.mode === m.id}
                aria-disabled={disabled}
                disabled={disabled}
                className={`${styles.card} ${value.mode === m.id ? styles.cardActive : ''}`}
                onClick={() => onChange({ ...value, mode: m.id })}
                data-testid={`${idPrefix}mode-${m.id}`}
              >
                <strong>{m.title}</strong>
                <small>{disabled ? 'Pick the drand beacon to use this mode.' : m.text}</small>
              </button>
            );
          })}
        </div>
      </div>

      <p
        className={`small ${styles.safety}`}
        data-testid={`${idPrefix}randomness-safety`}
        data-safety={safety}
      >
        {safety === 'safe' ? '✅' : safety === 'trusted-host' ? '⚠️' : 'ℹ️'} {safetyText(safety)}
      </p>
      <details className={styles.table}>
        <summary className="small">Which combinations are safe?</summary>
        <table className={styles.safetyTable}>
          <thead>
            <tr>
              <th>Mode</th>
              <th>Host also plays</th>
              <th>Dealer hosts</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Per draw</td>
              <td>Safe</td>
              <td>Safe</td>
            </tr>
            <tr>
              <td>Seeded</td>
              <td>Host knows the hand</td>
              <td>Safe</td>
            </tr>
            <tr>
              <td>Beacon</td>
              <td>Safe</td>
              <td>Safe</td>
            </tr>
          </tbody>
        </table>
        <p className="small muted">
          “Safe” means nobody can know a value before it is drawn and every draw can be verified
          afterwards. With “This device” as the source nothing is verifiable by others, whatever the
          mode.
        </p>
      </details>

      {showFallback && (
        <label className={styles.fallback}>
          <input
            type="checkbox"
            checked={value.fallback}
            onChange={(e) => onChange({ ...value, fallback: e.target.checked })}
            data-testid={`${idPrefix}fallback-toggle`}
          />
          <span>
            Use this device’s randomness if the oracle is unreachable
            <small>
              Otherwise the roll or deal is refused until it answers. Flagged in the audit.
            </small>
          </span>
        </label>
      )}

      {problem && (
        <p className="error-text small" role="alert" data-testid={`${idPrefix}randomness-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}
