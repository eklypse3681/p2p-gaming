import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { TableConfig } from '@bgf/ofc-engine';
import { RulesEditor } from './RulesEditor';
import { getPreset } from './presets';
import { loadRulesets } from './rulesets';

function Harness({ onChange }: { onChange?: (c: TableConfig) => void }) {
  const [cfg, setCfg] = useState<TableConfig>(() => getPreset('standard-pineapple')!.config);
  return (
    <>
      <RulesEditor
        value={cfg}
        onChange={(c) => {
          setCfg(c);
          onChange?.(c);
        }}
        slug="alice"
      />
      <pre data-testid="out">{JSON.stringify(cfg)}</pre>
    </>
  );
}

const out = () => JSON.parse(screen.getByTestId('out').textContent ?? '{}') as TableConfig;

describe('RulesEditor', () => {
  beforeEach(() => localStorage.clear());

  it('starts on a preset and becomes custom after an edit', async () => {
    render(<Harness />);
    expect(screen.getByTestId('rules-editor')).toHaveAttribute('data-preset', 'standard-pineapple');
    expect(screen.getByTestId('rules-preset-standard-pineapple')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const flush = screen.getByTestId('royalty-middle-flush');
    await userEvent.clear(flush);
    await userEvent.type(flush, '9');
    expect(screen.getByTestId('rules-editor')).toHaveAttribute('data-preset', 'custom');
    expect(screen.getByTestId('rules-custom')).toBeInTheDocument();
    expect(out().royalties.middle.flush).toBe(9);
    // Back to a preset restores every number.
    await userEvent.click(screen.getByTestId('rules-preset-pineapple27'));
    expect(out().variant).toBe('pineapple27');
    expect(out().fantasyland.entry).toBe('KK');
    expect(screen.getByTestId('royalty-low-wheel')).toBeInTheDocument();
    expect(screen.getByTestId('low-qualifier')).toHaveValue('10');
  });

  it('switching variant follows variant defaults only for untouched values', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('variant-ofc'));
    expect(out().fantasyland.cards).toBe(13);
    await userEvent.click(screen.getByTestId('variant-pineapple27'));
    expect(out().fantasyland.entry).toBe('KK');
    await userEvent.click(screen.getByTestId('fl-entry-AA'));
    await userEvent.click(screen.getByTestId('variant-pineapple'));
    expect(out().fantasyland.entry).toBe('AA');
  });

  it('scoring mode, buy-in and multiplier show a live example', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('scoring-buyin'));
    expect(out().scoring.mode).toBe('buyin');
    expect(out().scoring.buyIn).toBe(100);
    const mult = screen.getByTestId('multiplier-input');
    await userEvent.clear(mult);
    await userEvent.type(mult, '0.25');
    expect(screen.getByTestId('multiplier-example')).toHaveTextContent('1 point = $0.25');
    expect(screen.getByTestId('rules-summary')).toHaveTextContent('buy-in 100 · ×0.25');
    await userEvent.click(screen.getByTestId('bust-toggle'));
    expect(out().scoring.bustEnds).toBe(true);
    await userEvent.click(screen.getByTestId('seats-3'));
    expect(out().seats).toBe(3);
  });

  it('JSON panel applies valid rules and reports invalid ones', async () => {
    render(<Harness />);
    const ta = screen.getByTestId('rules-json') as HTMLTextAreaElement;
    await userEvent.clear(ta);
    await userEvent.paste('{"variant":"ofc","seats":3,"scoring":{"mode":"up","multiplier":2}}');
    await userEvent.click(screen.getByTestId('rules-json-apply'));
    expect(out().variant).toBe('ofc');
    expect(out().seats).toBe(3);
    expect(out().scoring.multiplier).toBe(2);
    await userEvent.clear(ta);
    await userEvent.paste('{"variant":"bogus"}');
    await userEvent.click(screen.getByTestId('rules-json-apply'));
    expect(screen.getByTestId('rules-json-error')).toHaveTextContent('variant');
    expect(out().variant).toBe('ofc');
  });

  it('saves and reloads a named rule set', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('rules-preset-pineapple27'));
    await userEvent.type(screen.getByTestId('ruleset-name'), 'Deuce night');
    await userEvent.click(screen.getByTestId('save-ruleset'));
    expect(Object.keys(loadRulesets('alice'))).toEqual(['Deuce night']);
    await userEvent.click(screen.getByTestId('rules-preset-standard-ofc'));
    expect(out().variant).toBe('ofc');
    await userEvent.click(screen.getByTestId('ruleset-Deuce night'));
    expect(out().variant).toBe('pineapple27');
    await userEvent.click(screen.getByTestId('delete-ruleset-Deuce night'));
    expect(loadRulesets('alice')).toEqual({});
  });
});
