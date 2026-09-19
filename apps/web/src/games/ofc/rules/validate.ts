// Validation lives in the engine so the web host screen and the dealer console share it.
export type { RulesValidation } from '@bgf/ofc-engine';
export { validateTableConfig, parseRulesJson, rulesToJson } from '@bgf/ofc-engine';
