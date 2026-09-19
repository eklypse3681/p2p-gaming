/**
 * Rule-set helpers shared by every UI that edits or displays OFC rules (the web host screen and
 * the dealer console): named presets, validation of pasted/loaded JSON, and one-line summaries.
 * Pure data + functions; no DOM.
 */
import type {
  FantasylandConfig,
  FantasylandEntry,
  RoyaltyConfig,
  Row,
  TableConfig,
  Variant,
  FlowConfig,
} from './types.js';
import { defaultConfig, middleIsLow, DEFAULT_FLOW } from './rules.js';

// ------------------------------------------------------------------------------------ presets

export interface RulesPreset {
  id: string;
  name: string;
  description: string;
  config: TableConfig;
}

function withFantasyland(config: TableConfig, patch: Partial<FantasylandConfig>): TableConfig {
  return { ...config, fantasyland: { ...config.fantasyland, ...patch } };
}

function base(variant: Variant, seats: 2 | 3 = 2): TableConfig {
  return defaultConfig({ variant, seats });
}

/** Named rule sets to start from. Any edit in an editor turns them into "Custom". */
export const RULES_PRESETS: readonly RulesPreset[] = [
  {
    id: 'standard-ofc',
    name: 'Standard OFC',
    description: 'One card at a time after the first five. Fantasyland on QQ, 13 cards.',
    config: base('ofc'),
  },
  {
    id: 'standard-pineapple',
    name: 'Standard Pineapple',
    description: 'Three cards a turn, set two, discard one. Fantasyland on QQ, 14 cards.',
    config: base('pineapple'),
  },
  {
    id: 'pineapple27',
    name: 'Pineapple 2-7',
    description:
      'Pineapple with the middle row scored deuce-to-seven; a ten-low or better avoids a foul.',
    config: base('pineapple27'),
  },
  {
    id: 'progressive-pineapple',
    name: 'Progressive Fantasyland Pineapple',
    description:
      'Standard Pineapple with 14 / 15 / 16 / 17 Fantasyland cards for QQ / KK / AA / trips.',
    config: withFantasyland(base('pineapple'), { progressive: true }),
  },
  {
    id: 'no-royalties',
    name: 'No royalties (points only)',
    description: 'Pineapple scored on rows and scoops alone: no bonuses for big hands.',
    config: {
      ...base('pineapple'),
      royalties: { ...base('pineapple').royalties, enabled: false },
    },
  },
];

export const DEFAULT_PRESET_ID = 'standard-pineapple';

export function getPreset(id: string): RulesPreset | undefined {
  return RULES_PRESETS.find((p) => p.id === id);
}

/** Stable, order-independent serialisation used to compare configs. */
export function configKey(config: TableConfig): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(defaultConfig(config)));
}

/** The preset a config equals exactly, ignoring seats (a table-size choice, not a rule). */
export function matchingPreset(config: TableConfig): RulesPreset | null {
  const key = configKey({ ...config, seats: 2 });
  return RULES_PRESETS.find((p) => configKey({ ...p.config, seats: 2 }) === key) ?? null;
}

// --------------------------------------------------------------------------------- describing

export function variantName(variant: Variant): string {
  switch (variant) {
    case 'ofc':
      return 'OFC';
    case 'pineapple':
      return 'Pineapple';
    case 'pineapple27':
      return 'Pineapple 2-7';
  }
}

export function variantLongName(variant: Variant): string {
  switch (variant) {
    case 'ofc':
      return 'Open Face Chinese';
    case 'pineapple':
      return 'Pineapple OFC';
    case 'pineapple27':
      return 'Pineapple 2-7 OFC';
  }
}

/** "Middle · 2-7" when the middle row is scored deuce-to-seven, else "Middle". */
export function rowLabel(config: Pick<TableConfig, 'variant'>, row: Row): string {
  const name = row === 'top' ? 'Top' : row === 'middle' ? 'Middle' : 'Bottom';
  return row === 'middle' && middleIsLow(config.variant) ? `${name} · 2-7` : name;
}

/** Fantasyland card counts as text: "14" or "14/15/16/17". */
export function fantasylandCardsText(config: TableConfig): string {
  const fl = config.fantasyland;
  if (fl.progressive) {
    const p = fl.progressiveCards;
    return `${p.QQ}/${p.KK}/${p.AA}/${p.trips}`;
  }
  return String(fl.cards);
}

/** Currency per point, e.g. "×0.25". */
export function multiplierText(multiplier: number): string {
  return `×${Number.isInteger(multiplier) ? multiplier : multiplier.toString()}`;
}

export function lowName(rank: number): string {
  const names: Record<number, string> = {
    8: 'eight',
    9: 'nine',
    10: 'ten',
    11: 'jack',
    12: 'queen',
    13: 'king',
  };
  return names[rank] ?? String(rank);
}

/**
 * One-line human summary of a rule set, e.g.
 * "Pineapple 2-7 · 3 players · buy-in 100 · ×0.25 · royalties on · FL KK 14".
 */
export function describeRules(config: TableConfig): string {
  const parts: string[] = [variantName(config.variant), `${config.seats} players`];
  const sc = config.scoring;
  if (sc.mode === 'buyin') parts.push(`buy-in ${sc.buyIn ?? 0}`);
  else parts.push('points up');
  if (sc.multiplier !== 1) parts.push(multiplierText(sc.multiplier));
  parts.push(config.royalties.enabled ? 'royalties on' : 'no royalties');
  const fl = config.fantasyland;
  if (fl.enabled) {
    parts.push(
      `FL ${fl.entry} ${fantasylandCardsText(config)}${fl.superFantasyland ? ' +super' : ''}`,
    );
  } else parts.push('no FL');
  if (config.variant === 'pineapple27' && config.lowQualifier !== 10) {
    parts.push(`${lowName(config.lowQualifier)}-low to qualify`);
  }
  return parts.join(' · ');
}

// --------------------------------------------------------------------------------- validation

export type RulesValidation = { ok: true; config: TableConfig } | { ok: false; errors: string[] };

const VARIANTS: readonly Variant[] = ['ofc', 'pineapple', 'pineapple27'];
const ENTRIES: readonly FantasylandEntry[] = ['QQ', 'KK', 'AA'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numberTable(
  raw: unknown,
  keys: readonly (string | number)[],
  path: string,
  errors: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    errors.push(`${path} must be an object of numbers`);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!keys.map(String).includes(k)) {
      errors.push(`${path}.${k} is not a known entry`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${path}.${k} must be a non-negative number`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export const HIGH_HAND_KEYS = [
  'high-card',
  'pair',
  'two-pair',
  'trips',
  'straight',
  'flush',
  'full-house',
  'quads',
  'straight-flush',
  'royal-flush',
] as const;
export const LOW_HAND_KEYS = ['ten', 'nine', 'eight', 'seven', 'wheel'] as const;
export const PAIR_RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export const TRIP_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

function optionalBool(raw: unknown, path: string, errors: string[], fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    errors.push(`${path} must be true or false`);
    return fallback;
  }
  return raw;
}

function optionalNumber(
  raw: unknown,
  path: string,
  errors: string[],
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${path} must be a number`);
    return fallback;
  }
  if (opts.integer && !Number.isInteger(raw)) errors.push(`${path} must be a whole number`);
  if (opts.min !== undefined && raw < opts.min) errors.push(`${path} must be at least ${opts.min}`);
  if (opts.max !== undefined && raw > opts.max) errors.push(`${path} must be at most ${opts.max}`);
  return raw;
}

/**
 * Check a raw rules object (typically pasted JSON) and normalise it into a full `TableConfig`.
 * Unknown keys are reported, wrong types are reported, and every number is range-checked so a
 * rule set exchanged between players cannot break the engine.
 */
export function validateTableConfig(raw: unknown): RulesValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['Rules must be a JSON object'] };
  const known = ['variant', 'seats', 'royalties', 'fantasyland', 'scoring', 'lowQualifier', 'flow'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) errors.push(`${k} is not a rule`);

  const variant = VARIANTS.includes(raw.variant as Variant) ? (raw.variant as Variant) : null;
  if (raw.variant !== undefined && !variant)
    errors.push('variant must be ofc, pineapple or pineapple27');
  const v: Variant = variant ?? 'pineapple';
  const seatsRaw = raw.seats === undefined ? 2 : raw.seats;
  if (seatsRaw !== 2 && seatsRaw !== 3) errors.push('seats must be 2 or 3');
  const seats = seatsRaw === 3 ? 3 : 2;

  const defaults = defaultConfig({ variant: v, seats });

  // Royalties
  const rr = raw.royalties;
  let royalties: RoyaltyConfig = defaults.royalties;
  if (rr !== undefined) {
    if (!isRecord(rr)) errors.push('royalties must be an object');
    else {
      const topPairs = numberTable(rr.topPairs, PAIR_RANKS, 'royalties.topPairs', errors);
      const topTrips = numberTable(rr.topTrips, TRIP_RANKS, 'royalties.topTrips', errors);
      const middle = numberTable(rr.middle, HIGH_HAND_KEYS, 'royalties.middle', errors);
      const bottom = numberTable(rr.bottom, HIGH_HAND_KEYS, 'royalties.bottom', errors);
      const middleLow = numberTable(rr.middleLow, LOW_HAND_KEYS, 'royalties.middleLow', errors);
      royalties = {
        enabled: optionalBool(rr.enabled, 'royalties.enabled', errors, defaults.royalties.enabled),
        topPairs: { ...defaults.royalties.topPairs, ...topPairs },
        topTrips: { ...defaults.royalties.topTrips, ...topTrips },
        middle: { ...defaults.royalties.middle, ...middle },
        bottom: { ...defaults.royalties.bottom, ...bottom },
        middleLow: { ...defaults.royalties.middleLow, ...middleLow },
      };
    }
  }

  // Fantasyland
  const fr = raw.fantasyland;
  let fantasyland = defaults.fantasyland;
  if (fr !== undefined) {
    if (!isRecord(fr)) errors.push('fantasyland must be an object');
    else {
      const d = defaults.fantasyland;
      const entry = fr.entry === undefined ? d.entry : (fr.entry as FantasylandEntry);
      if (!ENTRIES.includes(entry)) errors.push('fantasyland.entry must be QQ, KK or AA');
      const pc = isRecord(fr.progressiveCards) ? fr.progressiveCards : {};
      if (fr.progressiveCards !== undefined && !isRecord(fr.progressiveCards)) {
        errors.push('fantasyland.progressiveCards must be an object');
      }
      const stay = isRecord(fr.stay) ? fr.stay : {};
      if (fr.stay !== undefined && !isRecord(fr.stay))
        errors.push('fantasyland.stay must be an object');
      const cardCount = (raw: unknown, path: string, fallback: number) =>
        optionalNumber(raw, path, errors, fallback, { min: 13, max: 17, integer: true });
      fantasyland = {
        enabled: optionalBool(fr.enabled, 'fantasyland.enabled', errors, d.enabled),
        entry: ENTRIES.includes(entry) ? entry : d.entry,
        cards: cardCount(fr.cards, 'fantasyland.cards', d.cards),
        progressive: optionalBool(fr.progressive, 'fantasyland.progressive', errors, d.progressive),
        progressiveCards: {
          QQ: cardCount(pc.QQ, 'fantasyland.progressiveCards.QQ', d.progressiveCards.QQ),
          KK: cardCount(pc.KK, 'fantasyland.progressiveCards.KK', d.progressiveCards.KK),
          AA: cardCount(pc.AA, 'fantasyland.progressiveCards.AA', d.progressiveCards.AA),
          trips: cardCount(
            pc.trips,
            'fantasyland.progressiveCards.trips',
            d.progressiveCards.trips,
          ),
        },
        superFantasyland: optionalBool(
          fr.superFantasyland,
          'fantasyland.superFantasyland',
          errors,
          d.superFantasyland,
        ),
        stay: {
          topTrips: optionalBool(
            stay.topTrips,
            'fantasyland.stay.topTrips',
            errors,
            d.stay.topTrips,
          ),
          middleFullHouse: optionalBool(
            stay.middleFullHouse,
            'fantasyland.stay.middleFullHouse',
            errors,
            d.stay.middleFullHouse,
          ),
          bottomQuads: optionalBool(
            stay.bottomQuads,
            'fantasyland.stay.bottomQuads',
            errors,
            d.stay.bottomQuads,
          ),
        },
      };
    }
  }

  // Scoring
  const sr = raw.scoring;
  let scoring = defaults.scoring;
  if (sr !== undefined) {
    if (!isRecord(sr)) errors.push('scoring must be an object');
    else {
      const mode = sr.mode === undefined ? 'up' : sr.mode;
      if (mode !== 'up' && mode !== 'buyin') errors.push('scoring.mode must be up or buyin');
      const buyIn =
        sr.buyIn === undefined
          ? undefined
          : optionalNumber(sr.buyIn, 'scoring.buyIn', errors, 0, { min: 1 });
      if (mode === 'buyin' && !(buyIn && buyIn > 0))
        errors.push('scoring.buyIn must be a positive number in buy-in mode');
      scoring = {
        mode: mode === 'buyin' ? 'buyin' : 'up',
        ...(buyIn !== undefined ? { buyIn } : {}),
        multiplier: optionalNumber(sr.multiplier, 'scoring.multiplier', errors, 1, { min: 0 }),
        ...(sr.bustEnds !== undefined
          ? { bustEnds: optionalBool(sr.bustEnds, 'scoring.bustEnds', errors, false) }
          : {}),
      };
    }
  }

  const lowQualifier = optionalNumber(
    raw.lowQualifier,
    'lowQualifier',
    errors,
    defaults.lowQualifier,
    { min: 8, max: 13, integer: true },
  );

  // Table flow (unattended play)
  const fw = raw.flow;
  let flow: FlowConfig = defaults.flow ?? DEFAULT_FLOW;
  if (fw !== undefined) {
    if (!isRecord(fw)) errors.push('flow must be an object');
    else {
      const nextHand = fw.nextHand === undefined ? flow.nextHand : fw.nextHand;
      if (nextHand !== 'ready' && nextHand !== 'countdown')
        errors.push('flow.nextHand must be ready or countdown');
      flow = {
        startWhenFull: optionalBool(
          fw.startWhenFull,
          'flow.startWhenFull',
          errors,
          flow.startWhenFull,
        ),
        nextHand: nextHand === 'countdown' ? 'countdown' : 'ready',
        nextHandDelayMs: optionalNumber(
          fw.nextHandDelayMs,
          'flow.nextHandDelayMs',
          errors,
          flow.nextHandDelayMs,
          { min: 0, max: 600_000, integer: true },
        ),
        settleOnConsensus: optionalBool(
          fw.settleOnConsensus,
          'flow.settleOnConsensus',
          errors,
          flow.settleOnConsensus,
        ),
        pauseWhenAbsent: optionalBool(
          fw.pauseWhenAbsent,
          'flow.pauseWhenAbsent',
          errors,
          flow.pauseWhenAbsent,
        ),
      };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: defaultConfig({
      variant: v,
      seats,
      royalties,
      fantasyland,
      scoring,
      lowQualifier,
      flow,
    }),
  };
}

/** Parse a "Rules as JSON" text. */
export function parseRulesJson(text: string): RulesValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  return validateTableConfig(raw);
}

export function rulesToJson(config: TableConfig): string {
  return JSON.stringify(config, null, 2);
}
