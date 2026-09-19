import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '@bgf/ofc-engine';
import { RULES_PRESETS, configKey, getPreset, matchingPreset } from './presets';
import { describeRules, rowLabel, variantName } from './describe';
import { parseRulesJson, rulesToJson, validateTableConfig } from './validate';
import { deleteRuleset, loadRulesets, rulesetsKey, saveRuleset } from './rulesets';

describe('rules presets', () => {
  it('every preset is a full, valid config and matches itself', () => {
    for (const p of RULES_PRESETS) {
      const v = validateTableConfig(p.config);
      expect(v.ok, p.id).toBe(true);
      expect(matchingPreset(p.config)?.id).toBe(p.id);
      expect(matchingPreset({ ...p.config, seats: 3 })?.id).toBe(p.id);
    }
    expect(getPreset('pineapple27')!.config.variant).toBe('pineapple27');
    expect(getPreset('pineapple27')!.config.fantasyland.entry).toBe('KK');
    expect(getPreset('progressive-pineapple')!.config.fantasyland.progressive).toBe(true);
    expect(getPreset('no-royalties')!.config.royalties.enabled).toBe(false);
  });

  it('any edit turns a preset into custom', () => {
    const p = getPreset('standard-pineapple')!.config;
    const edited = {
      ...p,
      royalties: { ...p.royalties, middle: { ...p.royalties.middle, flush: 9 } },
    };
    expect(matchingPreset(edited)).toBeNull();
    expect(configKey(p)).not.toBe(configKey(edited));
  });
});

describe('describeRules', () => {
  it('summarises variant, players, scoring, royalties and Fantasyland', () => {
    const cfg = defaultConfig({
      variant: 'pineapple27',
      seats: 3,
      scoring: { mode: 'buyin', buyIn: 100, multiplier: 0.25 },
    });
    expect(describeRules(cfg)).toBe(
      'Pineapple 2-7 · 3 players · buy-in 100 · ×0.25 · royalties on · FL KK 14 +super',
    );
    const prog = defaultConfig({ variant: 'pineapple' });
    prog.fantasyland.progressive = true;
    expect(describeRules(prog)).toContain('FL QQ 14/15/16/17');
    const off = defaultConfig({ variant: 'ofc' });
    off.royalties.enabled = false;
    off.fantasyland.enabled = false;
    expect(describeRules(off)).toBe('OFC · 2 players · points up · no royalties · no FL');
    expect(variantName('ofc')).toBe('OFC');
    expect(rowLabel({ variant: 'pineapple27' }, 'middle')).toBe('Middle · 2-7');
    expect(rowLabel({ variant: 'pineapple' }, 'middle')).toBe('Middle');
  });
});

describe('validateTableConfig / JSON', () => {
  it('round-trips a config through JSON', () => {
    const cfg = getPreset('pineapple27')!.config;
    const r = parseRulesJson(rulesToJson(cfg));
    expect(r.ok).toBe(true);
    if (r.ok) expect(configKey(r.config)).toBe(configKey(cfg));
  });

  it('reports every problem instead of silently accepting', () => {
    const r = validateTableConfig({
      variant: 'poker',
      seats: 4,
      scoring: { mode: 'buyin', multiplier: -1 },
      royalties: { topPairs: { 5: 1, 6: -2 } },
      fantasyland: { entry: 'JJ', cards: 99 },
      lowQualifier: 3,
      extra: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join('\n');
      for (const needle of [
        'variant',
        'seats',
        'buyIn',
        'multiplier',
        'topPairs.5',
        'topPairs.6',
        'entry',
        'cards',
        'lowQualifier',
        'extra',
      ]) {
        expect(text).toContain(needle);
      }
    }
    expect(parseRulesJson('{not json').ok).toBe(false);
    expect(validateTableConfig('nope').ok).toBe(false);
  });

  it('fills defaults for partial rules and keeps explicit numbers', () => {
    const r = validateTableConfig({ variant: 'ofc', royalties: { middle: { flush: 9 } } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.fantasyland.cards).toBe(13);
      expect(r.config.royalties.middle.flush).toBe(9);
      expect(r.config.royalties.middle.straight).toBe(4);
      expect(r.config.seats).toBe(2);
    }
  });
});

describe('saved rule sets', () => {
  beforeEach(() => localStorage.clear());

  it('saves, lists, loads and deletes per player', () => {
    const cfg = getPreset('pineapple27')!.config;
    saveRuleset('alice', 'Thursday rules', cfg);
    expect(Object.keys(loadRulesets('alice'))).toEqual(['Thursday rules']);
    expect(loadRulesets('bob')).toEqual({});
    expect(configKey(loadRulesets('alice')['Thursday rules']!)).toBe(configKey(cfg));
    expect(() => saveRuleset('alice', '   ', cfg)).toThrow();
    deleteRuleset('alice', 'Thursday rules');
    expect(loadRulesets('alice')).toEqual({});
    // Corrupt entries are ignored, not thrown.
    localStorage.setItem(rulesetsKey('alice'), JSON.stringify({ bad: { variant: 'x' } }));
    expect(loadRulesets('alice')).toEqual({});
  });
});
