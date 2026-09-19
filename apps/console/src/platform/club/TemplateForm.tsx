import { useEffect, useMemo, useState } from 'react';
import type { TableConfig } from '@bgf/ofc-engine';
import { defaultConfig, validateTableConfig } from '@bgf/ofc-engine';
import type { TableTemplate } from '@bgf/protocol';
import type { GamePreset } from '../../api/client';
import { describeError } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { OfcRulesForm } from '../../pages/OfcRulesForm';
import { BackgammonForm } from '../../pages/NewTablePage';
import { GAME_ICON, GAME_NAME } from '../../pages/TablesPage';
import { platformApi } from '../api';
import type { ClubDetail, TemplateInput } from '../api';
import { bpsToPercent } from '../format';

type Game = 'ofc' | 'backgammon';
type RandomnessMode = 'default' | 'per-draw' | 'seeded' | 'beacon';
type Provider = 'crypto' | 'random.org' | 'drand';

/** Same shape `BackgammonForm` edits (its type is private to NewTablePage). */
interface BgConfig {
  length: number;
  crawford: boolean;
  jacoby: boolean;
  rules: 'enforced' | 'free';
  homeSide: 'left' | 'right';
}

/** The platform's `/api/presets` only knows OFC; these mirror the dealer's backgammon presets. */
export const BG_PRESETS: GamePreset[] = [
  {
    id: 'match-1',
    name: '1-point match',
    description: 'Single game, no cube decisions.',
    config: { length: 1, crawford: true, jacoby: false },
  },
  {
    id: 'match-3',
    name: '3-point match',
    description: 'Short match with the Crawford rule.',
    config: { length: 3, crawford: true, jacoby: false },
  },
  {
    id: 'match-5',
    name: '5-point match',
    description: 'The usual club length.',
    config: { length: 5, crawford: true, jacoby: false },
  },
  {
    id: 'match-7',
    name: '7-point match',
    description: 'Longer match, cube play matters.',
    config: { length: 7, crawford: true, jacoby: false },
  },
  {
    id: 'match-11',
    name: '11-point match',
    description: 'Tournament length.',
    config: { length: 11, crawford: true, jacoby: false },
  },
  {
    id: 'money',
    name: 'Money session',
    description: 'Unlimited games, Jacoby rule on.',
    config: { length: 0, crawford: false, jacoby: true },
  },
  {
    id: 'free-board',
    name: 'Free board',
    description: 'No rule enforcement: a physical board.',
    config: { length: 0, crawford: false, jacoby: false, rules: 'free' },
  },
];

function bgFrom(raw: unknown): BgConfig {
  const c = (raw ?? {}) as Partial<BgConfig>;
  return {
    length: typeof c.length === 'number' ? c.length : 5,
    crawford: c.crawford ?? true,
    jacoby: c.jacoby ?? true,
    rules: c.rules === 'free' ? 'free' : 'enforced',
    homeSide: c.homeSide === 'right' ? 'right' : 'left',
  };
}

function ofcFrom(raw: unknown): TableConfig {
  const checked = validateTableConfig(raw);
  return checked.ok ? checked.config : defaultConfig({ variant: 'pineapple', seats: 2 });
}

export interface TemplateFormProps {
  club: ClubDetail;
  roomId: string;
  /** Editing an existing template instead of adding one. */
  initial?: TableTemplate;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}

export function TemplateForm({ club, roomId, initial, onSaved, onCancel }: TemplateFormProps) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [game, setGame] = useState<Game>(initial?.game === 'backgammon' ? 'backgammon' : 'ofc');
  const [presets, setPresets] = useState<GamePreset[]>([]);
  const [ofc, setOfc] = useState<TableConfig>(() =>
    initial?.game === 'ofc'
      ? ofcFrom(initial.config)
      : defaultConfig({ variant: 'pineapple', seats: 2 }),
  );
  const [bg, setBg] = useState<BgConfig>(() =>
    bgFrom(initial?.game === 'backgammon' ? initial.config : null),
  );
  const [chipsPerPoint, setChipsPerPoint] = useState(String(initial?.stakes.chipsPerPoint ?? 1));
  const [buyInOn, setBuyInOn] = useState(!!initial?.stakes.buyIn);
  const [buyIn, setBuyIn] = useState({
    min: String(initial?.stakes.buyIn?.min ?? 100),
    max: String(initial?.stakes.buyIn?.max ?? 1000),
    default: String(initial?.stakes.buyIn?.default ?? 200),
  });
  const [rakeOn, setRakeOn] = useState(initial ? !!initial.stakes.rake : true);
  const [rakeBps, setRakeBps] = useState(
    String(initial?.stakes.rake?.basisPoints ?? club.minRakeBps),
  );
  const [rakeCap, setRakeCap] = useState(
    initial?.stakes.rake?.cap !== undefined ? String(initial.stakes.rake.cap) : '',
  );
  const [mode, setMode] = useState<RandomnessMode>(
    (initial?.randomness?.mode as RandomnessMode | undefined) ?? 'default',
  );
  const [provider, setProvider] = useState<Provider>(
    (initial?.randomness?.provider as Provider | undefined) ?? 'crypto',
  );
  const [alwaysOpen, setAlwaysOpen] = useState(initial?.alwaysOpen ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    platformApi
      .presets('ofc')
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  const ofcErrors = useMemo(() => {
    const v = validateTableConfig(ofc);
    return v.ok ? [] : v.errors;
  }, [ofc]);

  /** Problems shown live (the name is only checked on submit). */
  const problem = useMemo(() => {
    const cpp = Number(chipsPerPoint);
    if (!Number.isInteger(cpp) || cpp < 0) return 'Chips per point must be a non-negative integer.';
    if (rakeOn) {
      const bps = Number(rakeBps);
      if (!Number.isInteger(bps) || bps < club.minRakeBps)
        return `Rake must be at least ${club.minRakeBps} basis points (${bpsToPercent(club.minRakeBps)}); the platform refuses templates below that.`;
      if (rakeCap.trim() && (!Number.isInteger(Number(rakeCap)) || Number(rakeCap) < 0))
        return 'Rake cap must be a non-negative integer.';
    }
    if (buyInOn) {
      const [min, max, dflt] = [buyIn.min, buyIn.max, buyIn.default].map(Number) as [
        number,
        number,
        number,
      ];
      if (
        ![min, max, dflt].every((n) => Number.isInteger(n) && n >= 0) ||
        min > max ||
        dflt < min ||
        dflt > max
      )
        return 'Buy-in bounds must satisfy 0 ≤ min ≤ default ≤ max.';
    }
    if (mode === 'beacon' && provider !== 'drand') return 'Beacon mode needs the drand source.';
    if (game === 'ofc' && ofcErrors.length) return ofcErrors.join('; ');
    return null;
  }, [
    chipsPerPoint,
    rakeOn,
    rakeBps,
    rakeCap,
    buyInOn,
    buyIn,
    mode,
    provider,
    game,
    ofcErrors,
    club.minRakeBps,
  ]);

  /** Field setters that also drop a stale server error. */
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setError(null);
      set(v);
    };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('A template needs a name.');
    if (problem) return; // already shown live
    setBusy(true);
    try {
      const body: TemplateInput = {
        name: name.trim(),
        game,
        config:
          game === 'ofc'
            ? ofc
            : {
                length: bg.length,
                crawford: bg.crawford,
                jacoby: bg.jacoby,
                rules: bg.rules,
                homeSide: bg.homeSide,
              },
        seats: game === 'ofc' ? ofc.seats : 2,
        stakes: {
          chipsPerPoint: Number(chipsPerPoint),
          ...(buyInOn
            ? {
                buyIn: {
                  min: Number(buyIn.min),
                  max: Number(buyIn.max),
                  default: Number(buyIn.default),
                },
              }
            : {}),
          ...(rakeOn
            ? {
                rake: {
                  basisPoints: Number(rakeBps),
                  ...(rakeCap.trim() ? { cap: Number(rakeCap) } : {}),
                },
              }
            : {}),
        },
        ...(mode !== 'default' ? { randomness: { mode, provider } } : {}),
        alwaysOpen,
      };
      if (initial) await platformApi.updateTemplate(club.id, initial.id, body);
      else await platformApi.addTemplate(club.id, roomId, body);
      toast(initial ? 'Template updated' : 'Template added');
      await onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = problem ?? error;
  return (
    <form
      className="section stack"
      onSubmit={submit}
      data-testid="template-form"
      data-mode={initial ? 'edit' : 'add'}
    >
      <h3>{initial ? `Edit ${initial.name}` : 'New template'}</h3>
      <div className="row">
        <label className="field" style={{ flex: 1, minWidth: 220 }}>
          <span className="label">Template name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => edit(setName)(e.target.value)}
            placeholder="Pineapple 1/2"
            data-testid="template-name"
          />
        </label>
        <div className="field">
          <span className="label">Game</span>
          <div className="chips" role="radiogroup" aria-label="Game">
            {(['ofc', 'backgammon'] as const).map((g) => (
              <button
                key={g}
                type="button"
                className="chip"
                role="radio"
                aria-checked={game === g}
                onClick={() => setGame(g)}
                disabled={!!initial}
                data-testid={`template-game-${g}`}
              >
                {GAME_ICON[g]} {GAME_NAME[g]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {game === 'ofc' ? (
        <OfcRulesForm presets={presets} value={ofc} onChange={setOfc} />
      ) : (
        <div className="stack">
          <div className="chips" role="radiogroup" aria-label="Presets">
            {BG_PRESETS.map((p) => {
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
        </div>
      )}

      <section className="section stack">
        <h3>Stakes</h3>
        <div className="row">
          <label className="field">
            <span className="label">Chips per point ({club.currency.code}, minor units)</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={chipsPerPoint}
              onChange={(e) => edit(setChipsPerPoint)(e.target.value)}
              data-testid="stakes-chips-per-point"
              style={{ width: 180 }}
            />
            <span className="help">0 keeps score in points only; nothing moves in the ledger.</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={alwaysOpen}
              onChange={(e) => setAlwaysOpen(e.target.checked)}
              data-testid="template-always-open"
            />
            Always keep one table open in the lobby
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={buyInOn}
            onChange={(e) => edit(setBuyInOn)(e.target.checked)}
            data-testid="stakes-buyin-toggle"
          />
          Buy-in bounds (chips move from the member to the table on sit)
        </label>
        {buyInOn && (
          <div className="row">
            {(['min', 'default', 'max'] as const).map((k) => (
              <label key={k} className="field">
                <span className="label">{k}</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={buyIn[k]}
                  onChange={(e) => edit(setBuyIn)({ ...buyIn, [k]: e.target.value })}
                  data-testid={`stakes-buyin-${k}`}
                  style={{ width: 140 }}
                />
              </label>
            ))}
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={rakeOn}
            onChange={(e) => edit(setRakeOn)(e.target.checked)}
            data-testid="stakes-rake-toggle"
          />
          Rake (burned from every hand's winners; the platform minimum is{' '}
          {bpsToPercent(club.minRakeBps)})
        </label>
        {rakeOn && (
          <div className="row">
            <label className="field">
              <span className="label">Basis points</span>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                value={rakeBps}
                onChange={(e) => edit(setRakeBps)(e.target.value)}
                data-testid="stakes-rake-bps"
                style={{ width: 140 }}
              />
              <span className="help">
                {Number.isFinite(Number(rakeBps)) ? bpsToPercent(Number(rakeBps)) : '—'} of the
                chips that change hands
              </span>
            </label>
            <label className="field">
              <span className="label">Cap per hand (blank = none)</span>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                value={rakeCap}
                onChange={(e) => edit(setRakeCap)(e.target.value)}
                data-testid="stakes-rake-cap"
                style={{ width: 160 }}
              />
            </label>
          </div>
        )}
      </section>

      <section className="section stack">
        <h3>Randomness</h3>
        <div className="row">
          <label className="field">
            <span className="label">Mode</span>
            <select
              className="select"
              value={mode}
              onChange={(e) => setMode(e.target.value as RandomnessMode)}
              data-testid="template-randomness-mode"
              style={{ width: 240 }}
            >
              <option value="default">Platform default (per draw, crypto)</option>
              <option value="per-draw">Per draw (just in time)</option>
              <option value="seeded">Seeded hands (commit, then reveal)</option>
              <option value="beacon">Beacon rounds (drand)</option>
            </select>
          </label>
          {mode !== 'default' && (
            <label className="field">
              <span className="label">Source</span>
              <select
                className="select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
                data-testid="template-randomness-provider"
                style={{ width: 220 }}
              >
                <option value="crypto">Platform machine (crypto)</option>
                <option value="random.org">random.org (signed)</option>
                <option value="drand">drand beacon</option>
              </select>
            </label>
          )}
        </div>
        <p className="help">
          The platform deals every table and plays no seat, so each mode is fair; seeded and beacon
          modes add proofs players can check.
        </p>
      </section>

      {shown && (
        <p className="error-text" data-testid="template-error">
          {shown}
        </p>
      )}
      <div className="row">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy}
          data-testid="save-template"
        >
          {busy ? 'Saving…' : initial ? 'Save template' : 'Add template'}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={onCancel}
          data-testid="cancel-template"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
