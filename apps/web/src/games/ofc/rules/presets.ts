// The rule presets live in the engine so the web host screen and the dealer console share them.
export type { RulesPreset } from '@bgf/ofc-engine';
export {
  RULES_PRESETS,
  DEFAULT_PRESET_ID,
  getPreset,
  configKey,
  matchingPreset,
} from '@bgf/ofc-engine';
