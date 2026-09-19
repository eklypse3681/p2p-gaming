import type { TableConfig } from '@bgf/ofc-engine';
import { readJson, writeJson } from '../../../session/storage';
import { validateTableConfig } from './validate';

/** Named rule sets a player has saved, per player. */
export function rulesetsKey(slug: string): string {
  return `bgf:ofc-rulesets:${slug}`;
}

export type Rulesets = Record<string, TableConfig>;

export function loadRulesets(slug: string): Rulesets {
  const raw = readJson<Record<string, unknown>>(rulesetsKey(slug));
  const out: Rulesets = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, cfg] of Object.entries(raw)) {
    const v = validateTableConfig(cfg);
    if (v.ok) out[name] = v.config;
  }
  return out;
}

export function saveRuleset(slug: string, name: string, config: TableConfig): Rulesets {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error('Give the rule set a name');
  const all = loadRulesets(slug);
  all[trimmed] = config;
  writeJson(rulesetsKey(slug), all);
  return all;
}

export function deleteRuleset(slug: string, name: string): Rulesets {
  const all = loadRulesets(slug);
  delete all[name];
  writeJson(rulesetsKey(slug), all);
  return all;
}
