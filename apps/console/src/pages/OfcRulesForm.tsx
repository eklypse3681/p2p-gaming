import { useEffect, useMemo, useState } from 'react';
import type { TableConfig } from '@bgf/ofc-engine';
import {
  HIGH_HAND_KEYS,
  LOW_HAND_KEYS,
  PAIR_RANKS,
  TRIP_RANKS,
  describeRules,
  lowName,
  matchingPreset,
  parseRulesJson,
  rulesToJson,
} from '@bgf/ofc-engine';
import { api } from '../api/client';
import type { GamePreset, Ruleset } from '../api/client';
import { describeError } from '../api/useApi';
import { useToast } from '../components/Toast';

const RANK_NAMES: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankName = (r: number) => RANK_NAMES[r] ?? String(r);
const HIGH_NAMES: Record<string, string> = {
  'high-card': 'High card',
  pair: 'Pair',
  'two-pair': 'Two pair',
  trips: 'Trips',
  straight: 'Straight',
  flush: 'Flush',
  'full-house': 'Full house',
  quads: 'Quads',
  'straight-flush': 'Straight flush',
  'royal-flush': 'Royal flush',
};
const LOW_NAMES: Record<string, string> = {
  ten: 'Ten-low',
  nine: 'Nine-low',
  eight: 'Eight-low',
  seven: 'Seven-low',
  wheel: 'Wheel (7-5-4-3-2)',
};

export interface OfcRulesFormProps {
  presets: GamePreset[];
  value: TableConfig;
  onChange: (config: TableConfig) => void;
}

function Num({
  id,
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  integer = true,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        className="input input-sm"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(integer ? Math.round(n) : n);
        }}
        data-testid={id}
      />
    </label>
  );
}

function Chip({
  id,
  checked,
  onClick,
  children,
}: {
  id: string;
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      data-testid={id}
    >
      {children}
    </button>
  );
}

/** The full OFC rule editor: every royalty, Fantasyland and scoring number is editable. */
export function OfcRulesForm({ presets, value, onChange }: OfcRulesFormProps) {
  const toast = useToast();
  const cfg = value;
  const preset = useMemo(() => matchingPreset(cfg), [cfg]);
  // The textarea shows the live config until the user edits it; then their draft until applied.
  const [draft, setDraft] = useState<string | null>(null);
  const json = draft ?? rulesToJson(cfg);
  const jsonDirty = draft !== null;
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [rulesetName, setRulesetName] = useState('');
  useEffect(() => {
    api
      .rulesets()
      .then(setRulesets)
      .catch(() => setRulesets([]));
  }, []);

  const patch = (p: Partial<TableConfig>) => onChange({ ...cfg, ...p });
  const patchRoyalties = (p: Partial<TableConfig['royalties']>) =>
    patch({ royalties: { ...cfg.royalties, ...p } });
  const patchFl = (p: Partial<TableConfig['fantasyland']>) =>
    patch({ fantasyland: { ...cfg.fantasyland, ...p } });
  const patchScoring = (p: Partial<TableConfig['scoring']>) =>
    patch({ scoring: { ...cfg.scoring, ...p } });
  const isLow = cfg.variant === 'pineapple27';

  const applyJson = () => {
    const parsed = parseRulesJson(json);
    if (!parsed.ok) {
      setJsonErrors(parsed.errors);
      return;
    }
    setJsonErrors([]);
    setDraft(null);
    onChange(parsed.config);
  };
  const saveRuleset = async () => {
    try {
      await api.saveRuleset(rulesetName, cfg);
      setRulesets(await api.rulesets());
      setRulesetName('');
      toast('Rule set saved');
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };
  const deleteRuleset = async (name: string) => {
    try {
      await api.deleteRuleset(name);
      setRulesets(await api.rulesets());
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };

  return (
    <div className="stack" data-testid="rules-editor" data-preset={preset?.id ?? 'custom'}>
      <div className="field">
        <span className="label">Preset</span>
        <div className="chips" role="radiogroup" aria-label="Rule presets">
          {presets.map((p) => (
            <Chip
              key={p.id}
              id={`preset-${p.id}`}
              checked={preset?.id === p.id}
              onClick={() => onChange({ ...(p.config as TableConfig), seats: cfg.seats })}
            >
              {p.name}
            </Chip>
          ))}
          {!preset && (
            <span className="badge badge-accent" data-testid="rules-custom">
              Custom
            </span>
          )}
        </div>
        <span className="help">{preset ? preset.description : 'Custom rules.'}</span>
      </div>

      <div className="field">
        <span className="label">Variant</span>
        <div className="chips" role="radiogroup" aria-label="Variant">
          {(['ofc', 'pineapple', 'pineapple27'] as const).map((v) => (
            <Chip
              key={v}
              id={`variant-${v}`}
              checked={cfg.variant === v}
              onClick={() => patch({ variant: v })}
            >
              {v === 'ofc' ? 'OFC' : v === 'pineapple' ? 'Pineapple' : 'Pineapple 2-7'}
            </Chip>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <span className="label">Seats</span>
          <div className="chips" role="radiogroup" aria-label="Seats">
            {([2, 3] as const).map((n) => (
              <Chip
                key={n}
                id={`seats-${n}`}
                checked={cfg.seats === n}
                onClick={() => patch({ seats: n })}
              >
                {n} players
              </Chip>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Scoring</span>
          <div className="chips" role="radiogroup" aria-label="Scoring mode">
            <Chip
              id="scoring-up"
              checked={cfg.scoring.mode === 'up'}
              onClick={() => patchScoring({ mode: 'up' })}
            >
              Points up
            </Chip>
            <Chip
              id="scoring-buyin"
              checked={cfg.scoring.mode === 'buyin'}
              onClick={() => patchScoring({ mode: 'buyin', buyIn: cfg.scoring.buyIn ?? 100 })}
            >
              Buy-in
            </Chip>
          </div>
        </div>
      </div>
      <div className="row">
        {cfg.scoring.mode === 'buyin' && (
          <label className="field">
            <span className="label">Buy-in (points)</span>
            <input
              className="input"
              type="number"
              min={1}
              value={cfg.scoring.buyIn ?? 100}
              onChange={(e) => patchScoring({ buyIn: Math.max(1, Number(e.target.value) || 1) })}
              data-testid="buyin-input"
              style={{ width: 140 }}
            />
          </label>
        )}
        <label className="field">
          <span className="label">Multiplier (currency per point)</span>
          <input
            className="input"
            type="number"
            min={0}
            step={0.05}
            value={cfg.scoring.multiplier}
            onChange={(e) => patchScoring({ multiplier: Math.max(0, Number(e.target.value) || 0) })}
            data-testid="multiplier-input"
            style={{ width: 140 }}
          />
          <span className="help" data-testid="multiplier-example">
            1 point = {cfg.scoring.multiplier === 1 ? '1 unit' : `${cfg.scoring.multiplier} units`};
            a 6-point scoop pays {(6 * cfg.scoring.multiplier).toFixed(2)}
          </span>
        </label>
        {cfg.scoring.mode === 'buyin' && (
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.scoring.bustEnds ?? false}
              onChange={(e) => patchScoring({ bustEnds: e.target.checked })}
              data-testid="bust-toggle"
            />
            Busting ends the session
          </label>
        )}
      </div>

      <section className="section stack">
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.royalties.enabled}
            onChange={(e) => patchRoyalties({ enabled: e.target.checked })}
            data-testid="royalties-toggle"
          />
          <strong>Royalties</strong>
        </label>
        {cfg.royalties.enabled && (
          <>
            <div className="field">
              <span className="label">Top pairs</span>
              <div className="numgrid">
                {PAIR_RANKS.map((r) => (
                  <Num
                    key={r}
                    id={`royalty-top-pair-${rankName(r)}`}
                    label={`${rankName(r)}${rankName(r)}`}
                    value={cfg.royalties.topPairs[r] ?? 0}
                    onChange={(v) =>
                      patchRoyalties({ topPairs: { ...cfg.royalties.topPairs, [r]: v } })
                    }
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <span className="label">Top trips</span>
              <div className="numgrid">
                {TRIP_RANKS.map((r) => (
                  <Num
                    key={r}
                    id={`royalty-top-trips-${rankName(r)}`}
                    label={`${rankName(r)}${rankName(r)}${rankName(r)}`}
                    value={cfg.royalties.topTrips[r] ?? 0}
                    onChange={(v) =>
                      patchRoyalties({ topTrips: { ...cfg.royalties.topTrips, [r]: v } })
                    }
                  />
                ))}
              </div>
            </div>
            {isLow ? (
              <div className="field">
                <span className="label">Middle (2-7 lows)</span>
                <div className="numgrid">
                  {LOW_HAND_KEYS.map((k) => (
                    <Num
                      key={k}
                      id={`royalty-low-${k}`}
                      label={LOW_NAMES[k] ?? k}
                      value={cfg.royalties.middleLow[k] ?? 0}
                      onChange={(v) =>
                        patchRoyalties({ middleLow: { ...cfg.royalties.middleLow, [k]: v } })
                      }
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="field">
                <span className="label">Middle</span>
                <div className="numgrid">
                  {HIGH_HAND_KEYS.filter(
                    (k) => k !== 'high-card' && k !== 'pair' && k !== 'two-pair',
                  ).map((k) => (
                    <Num
                      key={k}
                      id={`royalty-middle-${k}`}
                      label={HIGH_NAMES[k] ?? k}
                      value={cfg.royalties.middle[k] ?? 0}
                      onChange={(v) =>
                        patchRoyalties({ middle: { ...cfg.royalties.middle, [k]: v } })
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="field">
              <span className="label">Bottom</span>
              <div className="numgrid">
                {HIGH_HAND_KEYS.filter(
                  (k) => k !== 'high-card' && k !== 'pair' && k !== 'two-pair' && k !== 'trips',
                ).map((k) => (
                  <Num
                    key={k}
                    id={`royalty-bottom-${k}`}
                    label={HIGH_NAMES[k] ?? k}
                    value={cfg.royalties.bottom[k] ?? 0}
                    onChange={(v) =>
                      patchRoyalties({ bottom: { ...cfg.royalties.bottom, [k]: v } })
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="section stack">
        <label className="check">
          <input
            type="checkbox"
            checked={cfg.fantasyland.enabled}
            onChange={(e) => patchFl({ enabled: e.target.checked })}
            data-testid="fl-toggle"
          />
          <strong>Fantasyland</strong>
        </label>
        {cfg.fantasyland.enabled && (
          <>
            <div className="row">
              <div className="field">
                <span className="label">Enter with</span>
                <div className="chips" role="radiogroup" aria-label="Fantasyland entry">
                  {(['QQ', 'KK', 'AA'] as const).map((e) => (
                    <Chip
                      key={e}
                      id={`fl-entry-${e}`}
                      checked={cfg.fantasyland.entry === e}
                      onClick={() => patchFl({ entry: e })}
                    >
                      {e}+
                    </Chip>
                  ))}
                </div>
                {isLow && (
                  <span className="help">A middle wheel (7-5-4-3-2) also enters in 2-7.</span>
                )}
              </div>
              {!cfg.fantasyland.progressive && (
                <label className="field">
                  <span className="label">Cards</span>
                  <input
                    className="input"
                    type="number"
                    min={13}
                    max={17}
                    value={cfg.fantasyland.cards}
                    onChange={(e) =>
                      patchFl({ cards: Math.min(17, Math.max(13, Number(e.target.value) || 13)) })
                    }
                    data-testid="fl-cards"
                    style={{ width: 100 }}
                  />
                </label>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={cfg.fantasyland.progressive}
                onChange={(e) => patchFl({ progressive: e.target.checked })}
                data-testid="fl-progressive"
              />
              Progressive (more cards for KK / AA / trips)
            </label>
            {cfg.fantasyland.progressive && (
              <div className="numgrid">
                {(['QQ', 'KK', 'AA', 'trips'] as const).map((k) => (
                  <Num
                    key={k}
                    id={`fl-prog-${k}`}
                    label={k}
                    min={13}
                    max={17}
                    value={cfg.fantasyland.progressiveCards[k]}
                    onChange={(v) =>
                      patchFl({
                        progressiveCards: {
                          ...cfg.fantasyland.progressiveCards,
                          [k]: Math.min(17, Math.max(13, v)),
                        },
                      })
                    }
                  />
                ))}
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={cfg.fantasyland.superFantasyland}
                onChange={(e) => patchFl({ superFantasyland: e.target.checked })}
                data-testid="fl-super"
              />
              Super Fantasyland (qualify twice in one hand: +1 card)
            </label>
            <div className="field">
              <span className="label">Stay in Fantasyland with</span>
              <div className="row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cfg.fantasyland.stay.topTrips}
                    onChange={(e) =>
                      patchFl({ stay: { ...cfg.fantasyland.stay, topTrips: e.target.checked } })
                    }
                    data-testid="fl-stay-topTrips"
                  />
                  Trips on top
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cfg.fantasyland.stay.middleFullHouse}
                    onChange={(e) =>
                      patchFl({
                        stay: { ...cfg.fantasyland.stay, middleFullHouse: e.target.checked },
                      })
                    }
                    data-testid="fl-stay-middleFullHouse"
                  />
                  {isLow ? 'Wheel in the middle' : 'Full house+ in the middle'}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cfg.fantasyland.stay.bottomQuads}
                    onChange={(e) =>
                      patchFl({ stay: { ...cfg.fantasyland.stay, bottomQuads: e.target.checked } })
                    }
                    data-testid="fl-stay-bottomQuads"
                  />
                  Quads+ on the bottom
                </label>
              </div>
            </div>
          </>
        )}
      </section>

      {isLow && (
        <section className="section stack">
          <label className="field">
            <span className="label">Middle must be at least</span>
            <select
              className="select"
              value={cfg.lowQualifier}
              onChange={(e) => patch({ lowQualifier: Number(e.target.value) })}
              data-testid="low-qualifier"
              style={{ width: 200 }}
            >
              {[8, 9, 10, 11, 12, 13].map((r) => (
                <option key={r} value={r}>
                  {lowName(r)}-low
                </option>
              ))}
            </select>
            <span className="help">
              Worse than this (or any pair, straight or flush) fouls the hand.
            </span>
          </label>
        </section>
      )}

      <section className="section stack">
        <div className="card-title">
          <h3>Rules as JSON</h3>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void navigator.clipboard?.writeText(json)}
              data-testid="rules-json-copy"
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={applyJson}
              disabled={!jsonDirty}
              data-testid="rules-json-apply"
            >
              Apply
            </button>
          </div>
        </div>
        <textarea
          className="textarea"
          value={json}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          data-testid="rules-json"
        />
        {jsonErrors.length > 0 && (
          <ul className="error-text" data-testid="rules-json-error">
            {jsonErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        <p className="help">
          Paste a rule set a friend sent you, or copy this one to share. It is exactly what the
          engine uses.
        </p>
      </section>

      <section className="section stack">
        <h3>Saved rule sets</h3>
        <div className="row">
          <input
            className="input"
            placeholder="Name this rule set"
            value={rulesetName}
            onChange={(e) => setRulesetName(e.target.value)}
            data-testid="ruleset-name"
            style={{ maxWidth: 260 }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void saveRuleset()}
            disabled={!rulesetName.trim()}
            data-testid="save-ruleset"
          >
            Save current rules
          </button>
        </div>
        {rulesets.length > 0 && (
          <div className="chips" data-testid="ruleset-list">
            {rulesets.map((r) => (
              <span key={r.name} className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className="chip"
                  onClick={() => onChange({ ...r.config, seats: cfg.seats })}
                  title={r.description}
                  data-testid={`ruleset-${r.name}`}
                >
                  {r.name}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void deleteRuleset(r.name)}
                  aria-label={`Delete ${r.name}`}
                  data-testid={`delete-ruleset-${r.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <p className="small muted" data-testid="rules-summary">
        {describeRules(cfg)}
      </p>
    </div>
  );
}
