import { useMemo, useState } from 'react';
import type { FantasylandEntry, TableConfig, Variant } from '@bgf/ofc-engine';
import { flowConfig } from '@bgf/ofc-engine';
import { defaultConfig, rankChar } from '@bgf/ofc-engine';
import type { Rank } from '@bgf/ofc-engine';
import { RULES_PRESETS, matchingPreset } from './presets';
import { parseRulesJson, rulesToJson } from './validate';
import { deleteRuleset, loadRulesets, saveRuleset } from './rulesets';
import { describeRules, lowName } from './describe';
import styles from './RulesEditor.module.css';

export interface RulesEditorProps {
  value: TableConfig;
  onChange: (config: TableConfig) => void;
  /** Player slug: named rule sets are saved per player. */
  slug: string;
}

const PAIR_RANKS: Rank[] = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const TRIP_RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const HIGH_ROWS: Array<{ key: keyof TableConfig['royalties']['middle']; label: string }> = [
  { key: 'trips', label: 'Trips' },
  { key: 'straight', label: 'Straight' },
  { key: 'flush', label: 'Flush' },
  { key: 'full-house', label: 'Full house' },
  { key: 'quads', label: 'Quads' },
  { key: 'straight-flush', label: 'Straight flush' },
  { key: 'royal-flush', label: 'Royal flush' },
];
const LOW_ROWS: Array<{ key: keyof TableConfig['royalties']['middleLow']; label: string }> = [
  { key: 'ten', label: 'Ten-low' },
  { key: 'nine', label: 'Nine-low' },
  { key: 'eight', label: 'Eight-low' },
  { key: 'seven', label: 'Seven-low' },
  { key: 'wheel', label: 'Wheel (7-5-4-3-2)' },
];

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function NumberCell({
  id,
  label,
  value,
  onChange,
  step = 1,
  min = 0,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <label className={styles.cell}>
      <span className={styles.cellLabel}>{label}</span>
      <input
        className={`input mono ${styles.cellInput}`}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Math.max(min, num(e.target.value, value)))}
        data-testid={id}
        aria-label={label}
      />
    </label>
  );
}

function Toggle({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.toggle} aria-disabled={disabled}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={id}
      />
      <span className={styles.toggleText}>
        {label}
        {help && <small>{help}</small>}
      </span>
    </label>
  );
}

/**
 * Every number in a rule set, editable. Presets fill the form; any edit turns the selection into
 * "Custom". The JSON panel is the exact engine `TableConfig`, so rule sets can be exchanged
 * between players and saved by name per player.
 */
export function RulesEditor({ value, onChange, slug }: RulesEditorProps) {
  const preset = useMemo(() => matchingPreset(value), [value]);
  const [rulesets, setRulesets] = useState(() => loadRulesets(slug));
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const set = (patch: Partial<TableConfig>) => onChange({ ...value, ...patch });
  const flow = flowConfig(value);
  const setFlow = (patch: Partial<TableConfig['flow'] & object>) =>
    onChange({ ...value, flow: { ...flow, ...patch } });
  const setRoyalties = (patch: Partial<TableConfig['royalties']>) =>
    set({ royalties: { ...value.royalties, ...patch } });
  const setFantasyland = (patch: Partial<TableConfig['fantasyland']>) =>
    set({ fantasyland: { ...value.fantasyland, ...patch } });
  const setScoring = (patch: Partial<TableConfig['scoring']>) =>
    set({ scoring: { ...value.scoring, ...patch } });

  const changeVariant = (variant: Variant) => {
    // Variant-specific defaults follow the variant unless the player changed them by hand.
    const oldDefault = defaultConfig({ variant: value.variant }).fantasyland;
    const newDefault = defaultConfig({ variant }).fantasyland;
    const fl = { ...value.fantasyland };
    if (fl.cards === oldDefault.cards) fl.cards = newDefault.cards;
    if (fl.entry === oldDefault.entry) fl.entry = newDefault.entry;
    onChange({ ...value, variant, fantasyland: fl });
  };

  const applyPreset = (id: string) => {
    const p = RULES_PRESETS.find((x) => x.id === id);
    if (p) onChange({ ...p.config, seats: value.seats });
    setJson(null);
    setJsonErrors([]);
  };

  const jsonText = json ?? rulesToJson(value);
  const applyJson = () => {
    const r = parseRulesJson(jsonText);
    if (r.ok) {
      onChange(r.config);
      setJson(null);
      setJsonErrors([]);
    } else setJsonErrors(r.errors);
  };
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the textarea is selectable */
    }
  };

  const save = () => {
    try {
      setRulesets(saveRuleset(slug, saveName, value));
      setSaveName('');
      setSaveError(null);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  const is27 = value.variant === 'pineapple27';
  const buyin = value.scoring.mode === 'buyin';
  const multiplier = value.scoring.multiplier;

  return (
    <div className={styles.editor} data-testid="rules-editor" data-preset={preset?.id ?? 'custom'}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="label">Presets</span>
          {preset ? (
            <span className="badge badge-accent" data-testid="rules-preset-current">
              {preset.name}
            </span>
          ) : (
            <span className="badge badge-outline-accent" data-testid="rules-custom">
              Custom
            </span>
          )}
        </div>
        <div className={styles.chips} role="radiogroup" aria-label="Rule presets">
          {RULES_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset?.id === p.id}
              className={`${styles.chip} ${preset?.id === p.id ? styles.chipActive : ''}`}
              onClick={() => applyPreset(p.id)}
              title={p.description}
              data-testid={`rules-preset-${p.id}`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <p className="muted small" data-testid="rules-summary">
          {describeRules(value)}
        </p>
        {Object.keys(rulesets).length > 0 && (
          <div className={styles.chips} data-testid="rulesets">
            <span className="muted small">Saved:</span>
            {Object.entries(rulesets).map(([name, cfg]) => (
              <span key={name} className={styles.savedChip}>
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => onChange({ ...cfg, seats: value.seats })}
                  data-testid={`ruleset-${name}`}
                >
                  {name}
                </button>
                <button
                  type="button"
                  className={styles.chipX}
                  aria-label={`Delete rule set ${name}`}
                  onClick={() => setRulesets(deleteRuleset(slug, name))}
                  data-testid={`delete-ruleset-${name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={styles.saveRow}>
          <input
            className="input"
            placeholder="Save these rules as…"
            value={saveName}
            onChange={(e) => {
              setSaveName(e.target.value);
              setSaveError(null);
            }}
            aria-label="Rule set name"
            data-testid="ruleset-name"
          />
          <button type="button" className="btn btn-sm" onClick={save} data-testid="save-ruleset">
            Save rule set
          </button>
          {saveError && <span className="error-text small">{saveError}</span>}
        </div>
      </section>

      <section className={styles.section}>
        <span className="label">Basics</span>
        <div className={styles.grid2}>
          <div className="field">
            <span className={styles.sub}>Variant</span>
            <div className={styles.chips} role="radiogroup" aria-label="Variant">
              {(
                [
                  ['ofc', 'OFC'],
                  ['pineapple', 'Pineapple'],
                  ['pineapple27', 'Pineapple 2-7'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={value.variant === id}
                  className={`${styles.chip} ${value.variant === id ? styles.chipActive : ''}`}
                  onClick={() => changeVariant(id)}
                  data-testid={`variant-${id}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className={styles.sub}>Players</span>
            <div className={styles.chips} role="radiogroup" aria-label="Players">
              {([2, 3] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={value.seats === n}
                  className={`${styles.chip} ${value.seats === n ? styles.chipActive : ''}`}
                  onClick={() => set({ seats: n })}
                  data-testid={`seats-${n}`}
                >
                  {n} players
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className={styles.sub}>Scoring</span>
            <div className={styles.chips} role="radiogroup" aria-label="Scoring mode">
              {(
                [
                  ['up', 'Count up'],
                  ['buyin', 'Buy-in (count down)'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={value.scoring.mode === id}
                  className={`${styles.chip} ${value.scoring.mode === id ? styles.chipActive : ''}`}
                  onClick={() =>
                    setScoring({
                      mode: id,
                      buyIn: id === 'buyin' ? (value.scoring.buyIn ?? 100) : value.scoring.buyIn,
                    })
                  }
                  data-testid={`scoring-${id}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="help">
              {buyin
                ? 'Everyone starts at the buy-in and the ledger counts down.'
                : 'Everyone starts at zero; points go up and down as hands are scored.'}
            </span>
          </div>
          <div className={styles.grid2}>
            {buyin && (
              <NumberCell
                id="buyin-input"
                label="Buy-in (points)"
                value={value.scoring.buyIn ?? 100}
                min={1}
                onChange={(n) => setScoring({ buyIn: n })}
              />
            )}
            <NumberCell
              id="multiplier-input"
              label="Multiplier (money per point)"
              value={multiplier}
              step={0.05}
              min={0}
              onChange={(n) => setScoring({ multiplier: n })}
            />
          </div>
        </div>
        <p className="muted small" data-testid="multiplier-example">
          1 point = ${multiplier.toFixed(2)} · a 6-point scoop = ${(6 * multiplier).toFixed(2)}
        </p>
        {buyin && (
          <Toggle
            id="bust-toggle"
            label="Table ends when someone busts"
            help="Stops the session as soon as a balance reaches zero."
            checked={!!value.scoring.bustEnds}
            onChange={(v) => setScoring({ bustEnds: v })}
          />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="label">Royalties</span>
          <Toggle
            id="royalties-toggle"
            label="Pay royalties"
            checked={value.royalties.enabled}
            onChange={(v) => setRoyalties({ enabled: v })}
          />
        </div>
        <div
          className={value.royalties.enabled ? '' : styles.dim}
          aria-disabled={!value.royalties.enabled}
        >
          <span className={styles.sub}>Top pairs</span>
          <div className={styles.cells} data-testid="royalty-top-pairs">
            {PAIR_RANKS.map((r) => (
              <NumberCell
                key={r}
                id={`royalty-top-pair-${rankChar(r)}`}
                label={`${rankChar(r)}${rankChar(r)}`}
                value={value.royalties.topPairs[r] ?? 0}
                onChange={(n) =>
                  setRoyalties({ topPairs: { ...value.royalties.topPairs, [r]: n } })
                }
              />
            ))}
          </div>
          <span className={styles.sub}>Top trips</span>
          <div className={styles.cells} data-testid="royalty-top-trips">
            {TRIP_RANKS.map((r) => (
              <NumberCell
                key={r}
                id={`royalty-top-trips-${rankChar(r)}`}
                label={`${rankChar(r)}${rankChar(r)}${rankChar(r)}`}
                value={value.royalties.topTrips[r] ?? 0}
                onChange={(n) =>
                  setRoyalties({ topTrips: { ...value.royalties.topTrips, [r]: n } })
                }
              />
            ))}
          </div>
          {is27 ? (
            <>
              <span className={styles.sub}>Middle (2-7 low)</span>
              <div className={styles.cells} data-testid="royalty-middle-low">
                {LOW_ROWS.map((row) => (
                  <NumberCell
                    key={row.key}
                    id={`royalty-low-${row.key}`}
                    label={row.label}
                    value={value.royalties.middleLow[row.key]}
                    onChange={(n) =>
                      setRoyalties({ middleLow: { ...value.royalties.middleLow, [row.key]: n } })
                    }
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <span className={styles.sub}>Middle</span>
              <div className={styles.cells} data-testid="royalty-middle">
                {HIGH_ROWS.map((row) => (
                  <NumberCell
                    key={row.key}
                    id={`royalty-middle-${row.key}`}
                    label={row.label}
                    value={value.royalties.middle[row.key] ?? 0}
                    onChange={(n) =>
                      setRoyalties({ middle: { ...value.royalties.middle, [row.key]: n } })
                    }
                  />
                ))}
              </div>
            </>
          )}
          <span className={styles.sub}>Bottom</span>
          <div className={styles.cells} data-testid="royalty-bottom">
            {HIGH_ROWS.filter((r) => r.key !== 'trips').map((row) => (
              <NumberCell
                key={row.key}
                id={`royalty-bottom-${row.key}`}
                label={row.label}
                value={value.royalties.bottom[row.key] ?? 0}
                onChange={(n) =>
                  setRoyalties({ bottom: { ...value.royalties.bottom, [row.key]: n } })
                }
              />
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="label">Fantasyland</span>
          <Toggle
            id="fl-toggle"
            label="Play Fantasyland"
            checked={value.fantasyland.enabled}
            onChange={(v) => setFantasyland({ enabled: v })}
          />
        </div>
        <div className={value.fantasyland.enabled ? '' : styles.dim}>
          <div className={styles.grid2}>
            <div className="field">
              <span className={styles.sub}>Enter with</span>
              <div className={styles.chips} role="radiogroup" aria-label="Fantasyland entry">
                {(['QQ', 'KK', 'AA'] as FantasylandEntry[]).map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={value.fantasyland.entry === e}
                    className={`${styles.chip} ${value.fantasyland.entry === e ? styles.chipActive : ''}`}
                    onClick={() => setFantasyland({ entry: e })}
                    data-testid={`fl-entry-${e}`}
                  >
                    {e}+ on top
                  </button>
                ))}
              </div>
              {is27 && <span className="help">A wheel (7-5-4-3-2) in the middle also enters.</span>}
            </div>
            <div className="field">
              <span className={styles.sub}>Cards</span>
              <Toggle
                id="fl-progressive"
                label="Progressive"
                help="More cards for a bigger entry: QQ / KK / AA / trips."
                checked={value.fantasyland.progressive}
                onChange={(v) => setFantasyland({ progressive: v })}
              />
              {value.fantasyland.progressive ? (
                <div className={styles.cells}>
                  {(['QQ', 'KK', 'AA', 'trips'] as const).map((k) => (
                    <NumberCell
                      key={k}
                      id={`fl-prog-${k}`}
                      label={k}
                      min={13}
                      value={value.fantasyland.progressiveCards[k]}
                      onChange={(n) =>
                        setFantasyland({
                          progressiveCards: { ...value.fantasyland.progressiveCards, [k]: n },
                        })
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className={styles.cells}>
                  <NumberCell
                    id="fl-cards"
                    label="Cards dealt"
                    min={13}
                    value={value.fantasyland.cards}
                    onChange={(n) => setFantasyland({ cards: n })}
                  />
                </div>
              )}
            </div>
          </div>
          <Toggle
            id="fl-super"
            label="Super Fantasyland"
            help="Qualifying twice in one hand deals one extra card."
            checked={value.fantasyland.superFantasyland}
            onChange={(v) => setFantasyland({ superFantasyland: v })}
          />
          <span className={styles.sub}>Stay in Fantasyland with</span>
          <div className={styles.toggles}>
            <Toggle
              id="fl-stay-topTrips"
              label="Trips on top"
              checked={value.fantasyland.stay.topTrips}
              onChange={(v) => setFantasyland({ stay: { ...value.fantasyland.stay, topTrips: v } })}
            />
            <Toggle
              id="fl-stay-middleFullHouse"
              label={is27 ? 'A wheel in the middle' : 'Full house or better in the middle'}
              checked={value.fantasyland.stay.middleFullHouse}
              onChange={(v) =>
                setFantasyland({ stay: { ...value.fantasyland.stay, middleFullHouse: v } })
              }
            />
            <Toggle
              id="fl-stay-bottomQuads"
              label="Quads or better on the bottom"
              checked={value.fantasyland.stay.bottomQuads}
              onChange={(v) =>
                setFantasyland({ stay: { ...value.fantasyland.stay, bottomQuads: v } })
              }
            />
          </div>
        </div>
      </section>

      <section className={styles.section} data-testid="rules-flow">
        <span className="label">Table flow</span>
        <span className="help">
          How an unattended table moves along. It deals when every seat is taken, and between hands:
        </span>
        <div className={styles.chips} role="radiogroup" aria-label="Next hand">
          {(
            [
              ['ready', 'When everyone is ready'],
              ['countdown', 'After a countdown'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={flow.nextHand === mode}
              className={`${styles.chip} ${flow.nextHand === mode ? styles.chipActive : ''}`}
              onClick={() => setFlow({ nextHand: mode })}
              data-testid={`flow-next-${mode}`}
            >
              {label}
            </button>
          ))}
        </div>
        {flow.nextHand === 'countdown' && (
          <div className="field">
            <label className={styles.sub} htmlFor="flow-delay">
              Countdown (seconds)
            </label>
            <input
              id="flow-delay"
              className="input mono"
              type="number"
              min={0}
              max={600}
              step={1}
              value={Math.round(flow.nextHandDelayMs / 1000)}
              onChange={(e) =>
                setFlow({
                  nextHandDelayMs: Math.max(0, Math.min(600, Number(e.target.value) || 0)) * 1000,
                })
              }
              data-testid="flow-delay"
            />
          </div>
        )}
        <Toggle
          id="flow-start-when-full"
          label="Deal the first hand as soon as every seat is taken"
          checked={flow.startWhenFull}
          onChange={(v) => setFlow({ startWhenFull: v })}
        />
        <Toggle
          id="flow-settle-consensus"
          label="Reset the scores when everyone asks"
          checked={flow.settleOnConsensus}
          onChange={(v) => setFlow({ settleOnConsensus: v })}
        />
      </section>

      <section className={styles.section}>
        <span className="label">Fouls</span>
        {is27 ? (
          <div className="field">
            <label className={styles.sub} htmlFor="low-qualifier">
              Middle must be this low or better
            </label>
            <select
              id="low-qualifier"
              className="select"
              value={value.lowQualifier}
              onChange={(e) => set({ lowQualifier: Number(e.target.value) })}
              data-testid="low-qualifier"
            >
              {[8, 9, 10, 11, 12, 13].map((r) => (
                <option key={r} value={r}>
                  {lowName(r)}-low
                </option>
              ))}
            </select>
            <span className="help">
              No pair, straight or flush in the middle, and the bottom must beat the top. Equal rows
              are not a foul.
            </span>
          </div>
        ) : (
          <p className="muted small">
            Bottom must be at least as strong as the middle, and the middle at least as strong as
            the top. Equal rows are not a foul. A foul loses every row, the scoop and all royalties.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="label">Rules as JSON</span>
          <span className="muted small">Paste a rule set from a friend, or copy yours.</span>
        </div>
        <textarea
          className={`textarea mono ${styles.json}`}
          value={jsonText}
          onChange={(e) => {
            setJson(e.target.value);
            setJsonErrors([]);
          }}
          spellCheck={false}
          rows={10}
          aria-label="Rules as JSON"
          data-testid="rules-json"
        />
        {jsonErrors.length > 0 && (
          <ul className={`error-text small ${styles.errors}`} data-testid="rules-json-error">
            {jsonErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={applyJson}
            disabled={json === null}
            data-testid="rules-json-apply"
          >
            Apply JSON
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={copyJson}
            data-testid="rules-json-copy"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          {json !== null && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setJson(null);
                setJsonErrors([]);
              }}
            >
              Revert
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
