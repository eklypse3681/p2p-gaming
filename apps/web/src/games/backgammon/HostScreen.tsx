import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Player, RulesMode } from '@bgf/engine';
import type { HomeSide } from '@bgf/protocol';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { getMatchStore } from '../../session/matchStore';
import { getProvider, getTransportName } from '../../session/providers';
import { hostNewMatch, SessionError } from '../../session/session';
import { useSessionRegistry } from '../../session/SessionRegistry';
import { HostTableOptions, useHostTableChoice } from '../../hud/HostTableOptions';
import { randomnessOptions, randomnessProblem } from '../../session/entropy';
import { describeTrust } from '@bgf/table';
import { backgammonDefinition } from '@bgf/server';
import { TrustPanel } from '../../hud/TrustPanel';
import styles from './HostScreen.module.css';

const LENGTHS = [1, 3, 5, 7, 11, 0] as const;

export function HostScreen() {
  const navigate = useNavigate();
  const registry = useSessionRegistry();
  const { profile, slug, ready } = useProfile();
  const { path, id: gameId } = useGame();
  const [length, setLength] = useState<number>(5);
  const [crawford, setCrawford] = useState(true);
  const [jacoby, setJacoby] = useState(true);
  const [seat, setSeat] = useState<Player>('white');
  const [rules, setRules] = useState<RulesMode>('enforced');
  const [homeSide, setHomeSide] = useState<HomeSide>('left');
  const [table, setTable] = useHostTableChoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlimited = length === 0;
  const free = rules === 'free';
  const transport = getTransportName();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = randomnessProblem(table.randomness);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { profile, signer } = await ready();
      const session = await hostNewMatch(
        {
          profile,
          signer: signer ?? undefined,
          // The cube is set by hand on a free board, so Crawford has nothing to enforce.
          config: { length, crawford: crawford && !free, jacoby, rules },
          hostSeat: seat,
          homeSide,
          dealer: table.dealer,
          randomness: table.randomness,
          autopilot: !table.manualDealing,
        },
        { provider: getProvider(slug, gameId), store: getMatchStore(slug, gameId) },
      );
      registry.add(slug, gameId, session);
      navigate(path(`/game/${session.matchId}`), { replace: true });
    } catch (err) {
      setError(err instanceof SessionError ? err.message : 'Could not create the match');
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow" data-testid="host-screen">
      <form className={`card ${styles.form}`} onSubmit={submit}>
        <div>
          <div className="eyebrow">Host</div>
          <h1>New match</h1>
          <p className="muted">
            Your browser will run the table. Keep this tab open while you play.
          </p>
        </div>

        <p className="muted small" data-testid="host-as">
          Hosting as <span aria-hidden="true">{profile.avatar}</span>{' '}
          <strong>{profile.name}</strong>
        </p>

        <div className="field">
          <span className="label">Rules</span>
          <div className={styles.rules} role="radiogroup" aria-label="Rules">
            {(
              [
                {
                  id: 'enforced',
                  title: 'Enforced',
                  icon: '⚖️',
                  text: 'Only legal moves. Dice, turns, the cube and scoring are all enforced.',
                },
                {
                  id: 'free',
                  title: 'Free board',
                  icon: '🪵',
                  text: 'A physical board: move anything, roll anytime, keep score yourself.',
                },
              ] as const
            ).map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={rules === r.id}
                className={`${styles.rule} ${rules === r.id ? styles.ruleActive : ''}`}
                onClick={() => setRules(r.id)}
                data-testid={`rules-${r.id}`}
              >
                <span className={styles.ruleIcon} aria-hidden="true">
                  {r.icon}
                </span>
                <span className={styles.ruleText}>
                  <strong>{r.title}</strong>
                  <small>{r.text}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="label">Match length</span>
          <div className={styles.lengths} role="radiogroup" aria-label="Match length">
            {LENGTHS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={length === n}
                className={`${styles.chip} ${length === n ? styles.chipActive : ''}`}
                onClick={() => setLength(n)}
                data-testid={`length-${n}`}
              >
                {n === 0 ? '∞ Unlimited' : `${n} pt${n === 1 ? '' : 's'}`}
              </button>
            ))}
          </div>
          <span className="help">
            {unlimited
              ? 'Money-style session: play game after game, points keep accumulating.'
              : `First to ${length} point${length === 1 ? '' : 's'} wins the match.`}
          </span>
        </div>

        <div className={styles.toggles}>
          <label className={styles.toggle} aria-disabled={unlimited || free} hidden={free}>
            <input
              type="checkbox"
              checked={crawford && !unlimited && !free}
              disabled={unlimited || free}
              onChange={(e) => setCrawford(e.target.checked)}
              data-testid="crawford-toggle"
            />
            <span className={styles.toggleText}>
              Crawford rule
              <small>No doubling in the game right after someone reaches match point.</small>
            </span>
          </label>
          <label className={styles.toggle} aria-disabled={!unlimited}>
            <input
              type="checkbox"
              checked={jacoby && unlimited}
              disabled={!unlimited}
              onChange={(e) => setJacoby(e.target.checked)}
              data-testid="jacoby-toggle"
            />
            <span className={styles.toggleText}>
              Jacoby rule
              <small>Gammons and backgammons only count if the cube has been turned.</small>
            </span>
          </label>
        </div>

        <div className="field">
          <span className="label">Table layout</span>
          <div className={styles.rules} role="radiogroup" aria-label="Table layout">
            {(
              [
                {
                  id: 'left',
                  title: 'Home boards on my left',
                  icon: '⬅️',
                  text: '1 bottom-left, 24 top-left. Checkers travel clockwise.',
                },
                {
                  id: 'right',
                  title: 'Home boards on my right',
                  icon: '➡️',
                  text: '1 bottom-right, 24 top-right. Checkers travel counter-clockwise.',
                },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={homeSide === o.id}
                className={`${styles.rule} ${homeSide === o.id ? styles.ruleActive : ''}`}
                onClick={() => setHomeSide(o.id)}
                data-testid={`home-side-${o.id}`}
              >
                <span className={styles.ruleIcon} aria-hidden="true">
                  {o.icon}
                </span>
                <span className={styles.ruleText}>
                  <strong>{o.title}</strong>
                  <small>{o.text}</small>
                </span>
              </button>
            ))}
          </div>
          <span className="help">
            Your opponent sees the table from the other side, so their home board is on the opposite
            side.
          </span>
        </div>

        <HostTableOptions
          value={table}
          onChange={setTable}
          dealerHelp="Both colours are taken by the players who join; this device only runs the table and rolls the dice."
        />
        <TrustPanel
          trust={describeTrust(backgammonDefinition, {
            hostSeat: table.dealer ? null : 0,
            randomness: randomnessOptions(table.randomness),
          })}
        />

        <div className="field" hidden={table.dealer}>
          <span className="label">You play as</span>
          <div className={styles.seats} role="radiogroup" aria-label="Seat">
            {(['white', 'black'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={seat === s}
                className={`${styles.seat} ${seat === s ? styles.seatActive : ''}`}
                onClick={() => setSeat(s)}
                data-testid={`seat-${s}`}
              >
                <span
                  className={`${styles.dot} ${s === 'white' ? styles.dotWhite : styles.dotBlack}`}
                />
                {s === 'white' ? 'White' : 'Black'}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="error-text" role="alert" data-testid="host-error">
            {error}
          </div>
        )}

        <div className={styles.footer}>
          <button
            className="btn btn-primary btn-lg"
            type="submit"
            disabled={busy}
            data-testid="create-match-button"
          >
            {busy ? 'Setting up the table…' : 'Create match'}
          </button>
          <Link to={path('/')} className="btn btn-ghost">
            Cancel
          </Link>
          <span className="help">
            Transport: <code>{transport}</code>
          </span>
        </div>
      </form>
    </div>
  );
}
