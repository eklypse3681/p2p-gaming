import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TableConfig } from '@bgf/ofc-engine';
import { defaultConfig, ofcDefinition, validateTableConfig } from '@bgf/ofc-engine';
import type { RandomnessMode } from '@bgf/protocol';
import { describeTrust } from '@bgf/table';
import { backgammonDefinition } from '@bgf/server';
import { api } from '../api/client';
import type { GamePreset, PublicSettings } from '../api/client';
import { describeError } from '../api/useApi';
import { useToast } from '../components/Toast';
import { OfcRulesForm } from './OfcRulesForm';
import { GAME_ICON, GAME_NAME } from './TablesPage';

type Game = 'backgammon' | 'ofc';

interface BgConfig {
  length: number;
  crawford: boolean;
  jacoby: boolean;
  rules: 'enforced' | 'free';
  homeSide: 'left' | 'right';
}

const RANDOMNESS_HELP: Record<string, string> = {
  'per-draw':
    'Each deal or roll fetches fresh bytes at that moment. Proofs ride with every action.',
  seeded:
    'One committed seed per hand (or game); revealed afterwards so the whole segment can be re-derived. Safe with a non-playing dealer.',
  beacon:
    'Every draw is bound to a future drand round chosen before it exists, so nobody can know a value early. Needs the drand source.',
};
const SOURCE_HELP: Record<string, string> = {
  crypto:
    "This machine's cryptographic generator. Fast; the audit records the bytes but there is no external proof.",
  'random.org':
    'Signed integers from random.org, verifiable by anyone with the serial numbers. Needs an API key (Settings).',
  drand:
    'The League of Entropy public beacon: a new verifiable value every 3 seconds, no key needed.',
};

export function BackgammonForm({
  value,
  onChange,
}: {
  value: BgConfig;
  onChange: (v: BgConfig) => void;
}) {
  const set = <K extends keyof BgConfig>(k: K, v: BgConfig[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="stack" data-testid="bg-form">
      <div className="field">
        <span className="label">Match length</span>
        <div className="chips" role="radiogroup" aria-label="Match length">
          {[1, 3, 5, 7, 11, 0].map((n) => (
            <button
              key={n}
              type="button"
              className="chip"
              role="radio"
              aria-checked={value.length === n}
              onClick={() => set('length', n)}
              data-testid={`length-${n}`}
            >
              {n === 0 ? '∞ Money' : `${n} pt${n === 1 ? '' : 's'}`}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={value.crawford}
            disabled={value.length === 0}
            onChange={(e) => set('crawford', e.target.checked)}
            data-testid="crawford-toggle"
          />
          Crawford rule
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.jacoby}
            disabled={value.length !== 0}
            onChange={(e) => set('jacoby', e.target.checked)}
            data-testid="jacoby-toggle"
          />
          Jacoby rule
        </label>
      </div>
      <div className="row">
        <div className="field">
          <span className="label">Rules</span>
          <div className="chips" role="radiogroup" aria-label="Rules">
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={value.rules === 'enforced'}
              onClick={() => set('rules', 'enforced')}
              data-testid="rules-enforced"
            >
              Enforced
            </button>
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={value.rules === 'free'}
              onClick={() => set('rules', 'free')}
              data-testid="rules-free"
            >
              Free board
            </button>
          </div>
        </div>
        <div className="field">
          <span className="label">Home boards (from seat 0)</span>
          <div className="chips" role="radiogroup" aria-label="Home side">
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={value.homeSide === 'left'}
              onClick={() => set('homeSide', 'left')}
              data-testid="home-side-left"
            >
              Left
            </button>
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={value.homeSide === 'right'}
              onClick={() => set('homeSide', 'right')}
              data-testid="home-side-right"
            >
              Right
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewTablePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [game, setGame] = useState<Game>('ofc');
  const [presets, setPresets] = useState<GamePreset[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [ofc, setOfc] = useState<TableConfig>(() =>
    defaultConfig({ variant: 'pineapple', seats: 2 }),
  );
  const [bg, setBg] = useState<BgConfig>({
    length: 5,
    crawford: true,
    jacoby: true,
    rules: 'enforced',
    homeSide: 'left',
  });
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  // Follow the dealer's defaults until the user picks something.
  const [entropyChoice, setEntropy] = useState<string | null>(null);
  const [randomnessChoice, setRandomness] = useState<string | null>(null);
  const entropy = entropyChoice ?? settings?.defaultEntropy ?? 'crypto';
  const randomness = randomnessChoice ?? settings?.defaultRandomness ?? 'per-draw';
  const [fallback, setFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch(() => {});
  }, []);
  useEffect(() => {
    api
      .presets(game)
      .then(setPresets)
      .catch((e) => toast(describeError(e), 'error'));
  }, [game, toast]);

  const ofcErrors = useMemo(() => {
    const v = validateTableConfig(ofc);
    return v.ok ? [] : v.errors;
  }, [ofc]);
  const trust = describeTrust(game === 'ofc' ? ofcDefinition : backgammonDefinition, {
    hostSeat: null,
    randomness: { mode: randomness as RandomnessMode, provider: entropy },
  });
  const randomnessProblem =
    randomness === 'beacon' && entropy !== 'drand'
      ? 'Beacon mode needs the drand source.'
      : entropy === 'random.org' && settings && !settings.hasRandomOrgKey
        ? 'Add a random.org API key in Settings first.'
        : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (game === 'ofc' && ofcErrors.length) return setError(ofcErrors.join('; '));
    if (randomnessProblem) return setError(randomnessProblem);
    setBusy(true);
    try {
      const info = await api.createTable({
        game,
        config:
          game === 'ofc'
            ? ofc
            : { length: bg.length, crawford: bg.crawford, jacoby: bg.jacoby, rules: bg.rules },
        seats: game === 'ofc' ? ofc.seats : 2,
        name: name.trim() || undefined,
        code: code.trim() || undefined,
        entropy,
        randomness,
        fallback,
        options: game === 'backgammon' ? { homeSide: bg.homeSide } : undefined,
      });
      toast(`Table ${info.code} created`);
      navigate(`/tables/${info.id}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" data-testid="new-table-page">
      <div>
        <span className="eyebrow">New table</span>
        <h1>Set up a table</h1>
        <p className="muted">
          The dealer hosts it and plays no seat. Players join with the invite link or QR code.
        </p>
      </div>
      <form className="two-col" onSubmit={submit}>
        <div className="stack">
          <section className="card stack">
            <h2>Game</h2>
            <div className="chips" role="radiogroup" aria-label="Game">
              {(['backgammon', 'ofc'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  className="chip"
                  role="radio"
                  aria-checked={game === g}
                  onClick={() => setGame(g)}
                  data-testid={`game-${g}`}
                >
                  {GAME_ICON[g]} {GAME_NAME[g]}
                </button>
              ))}
            </div>
          </section>
          <section className="card stack">
            <h2>{game === 'ofc' ? 'Rules' : 'Match'}</h2>
            {game === 'ofc' ? (
              <OfcRulesForm presets={presets} value={ofc} onChange={setOfc} />
            ) : (
              <>
                <div className="chips" role="radiogroup" aria-label="Presets">
                  {presets.map((p) => {
                    const c = p.config as Partial<BgConfig>;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="chip"
                        role="radio"
                        aria-checked={false}
                        onClick={() =>
                          setBg({
                            ...bg,
                            length: c.length ?? 5,
                            crawford: !!c.crawford,
                            jacoby: !!c.jacoby,
                            rules: c.rules === 'free' ? 'free' : 'enforced',
                          })
                        }
                        data-testid={`preset-${p.id}`}
                        title={p.description}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
                <BackgammonForm value={bg} onChange={setBg} />
              </>
            )}
          </section>
        </div>
        <aside className="stack">
          <section className="card stack">
            <h2>Hosting</h2>
            <label className="field">
              <span className="label">Table name (optional)</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Friday night"
                data-testid="table-name"
              />
            </label>
            <label className="field">
              <span className="label">Room code (optional)</span>
              <input
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="generated"
                maxLength={12}
                data-testid="table-code"
              />
            </label>
            <label className="field">
              <span className="label">Randomness source</span>
              <select
                className="select"
                value={entropy}
                onChange={(e) => setEntropy(e.target.value)}
                data-testid="entropy-select"
              >
                <option value="crypto">This machine (crypto)</option>
                <option value="random.org">random.org (signed)</option>
                <option value="drand">drand beacon</option>
              </select>
              <span className="help">{SOURCE_HELP[entropy]}</span>
            </label>
            <div className="field">
              <span className="label">Randomness mode</span>
              <div className="chips" role="radiogroup" aria-label="Randomness mode">
                {(['per-draw', 'seeded', 'beacon'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="chip"
                    role="radio"
                    aria-checked={randomness === m}
                    onClick={() => setRandomness(m)}
                    data-testid={`randomness-${m}`}
                  >
                    {m === 'per-draw' ? 'Per draw' : m === 'seeded' ? 'Seeded' : 'Beacon'}
                  </button>
                ))}
              </div>
              <span className="help">{RANDOMNESS_HELP[randomness]}</span>
              <span className="help">
                Because the dealer plays no seat, every mode is fair here; seeded hands reveal their
                seed at the end of each hand so players can check them.
              </span>
            </div>
            <section className="card stack-sm" data-testid="trust-panel" data-level={trust.level}>
              <strong>{trust.title}</strong>
              <ul className="help" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {trust.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
            {entropy !== 'crypto' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={fallback}
                  onChange={(e) => setFallback(e.target.checked)}
                  data-testid="fallback-toggle"
                />
                Fall back to this machine if the source is unreachable (flagged in the audit)
              </label>
            )}
            {(randomnessProblem || error) && (
              <p className="error-text" data-testid="create-error">
                {error ?? randomnessProblem}
              </p>
            )}
            {game === 'ofc' && ofcErrors.length > 0 && (
              <p className="error-text" data-testid="rules-errors">
                {ofcErrors.join('; ')}
              </p>
            )}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || (game === 'ofc' && ofcErrors.length > 0)}
              data-testid="create-table"
            >
              {busy ? 'Creating…' : 'Create table'}
            </button>
          </section>
        </aside>
      </form>
    </main>
  );
}
