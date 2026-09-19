import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HashRouter } from 'react-router';
import { ToastProvider } from '../components/Toast';
import { NewTablePage } from './NewTablePage';
import { OFC_PRESETS, fakeTable, installFakeApi } from '../test/fakeApi';

function renderPage() {
  return render(
    <HashRouter>
      <ToastProvider>
        <NewTablePage />
      </ToastProvider>
    </HashRouter>,
  );
}

const settings = {
  appUrl: 'http://app/',
  dealerName: 'House',
  defaultEntropy: 'crypto',
  randomOrgApiKey: '',
  hasRandomOrgKey: false,
  defaultRandomness: 'per-draw',
  consoleToken: '',
};

describe('NewTablePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies a preset, edits a royalty into a custom rule set, round-trips the JSON and creates the table', async () => {
    let created: Record<string, unknown> | null = null;
    installFakeApi({
      'GET /api/settings': () => settings,
      'GET /api/presets': () => OFC_PRESETS,
      'GET /api/rulesets': () => [],
      'POST /api/tables': (init) => {
        created = JSON.parse(String(init.body)) as Record<string, unknown>;
        return fakeTable({ id: 'new-1', code: 'NEW001' });
      },
    });
    renderPage();
    await screen.findByTestId('preset-pineapple27');
    await userEvent.click(screen.getByTestId('preset-pineapple27'));
    expect(screen.getByTestId('rules-editor')).toHaveAttribute('data-preset', 'pineapple27');
    expect(screen.getByTestId('rules-summary')).toHaveTextContent('Pineapple 2-7');
    expect(screen.getByTestId('royalty-low-wheel')).toBeInTheDocument();

    // Editing a number makes it custom and shows in the JSON.
    const wheel = screen.getByTestId('royalty-low-wheel') as HTMLInputElement;
    await userEvent.clear(wheel);
    await userEvent.type(wheel, '6');
    expect(screen.getByTestId('rules-editor')).toHaveAttribute('data-preset', 'custom');
    expect((screen.getByTestId('rules-json') as HTMLTextAreaElement).value).toContain('"wheel": 6');

    // Seats and buy-in.
    await userEvent.click(screen.getByTestId('seats-3'));
    await userEvent.click(screen.getByTestId('scoring-buyin'));
    const buyin = screen.getByTestId('buyin-input') as HTMLInputElement;
    await userEvent.clear(buyin);
    await userEvent.type(buyin, '200');

    // JSON apply with an error, then a valid paste.
    const json = screen.getByTestId('rules-json') as HTMLTextAreaElement;
    await userEvent.clear(json);
    await userEvent.type(json, '{{"variant":"nope"}');
    await userEvent.click(screen.getByTestId('rules-json-apply'));
    expect(screen.getByTestId('rules-json-error')).toHaveTextContent('variant must be');
    await userEvent.clear(json);
    await userEvent.type(json, '{{"variant":"ofc","seats":2,"fantasyland":{{"entry":"AA"}}');
    await userEvent.click(screen.getByTestId('rules-json-apply'));
    await waitFor(() => expect(screen.queryByTestId('rules-json-error')).not.toBeInTheDocument());
    expect(screen.getByTestId('variant-ofc')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('fl-entry-AA')).toHaveAttribute('aria-checked', 'true');

    await userEvent.type(screen.getByTestId('table-name'), 'Ours');
    await userEvent.click(screen.getByTestId('randomness-seeded'));
    await userEvent.click(screen.getByTestId('create-table'));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({
      game: 'ofc',
      name: 'Ours',
      randomness: 'seeded',
      entropy: 'crypto',
      seats: 2,
    });
    expect((created!.config as { variant: string; fantasyland: { entry: string } }).variant).toBe(
      'ofc',
    );
    expect((created!.config as { fantasyland: { entry: string } }).fantasyland.entry).toBe('AA');
    await waitFor(() => expect(window.location.hash).toBe('#/tables/new-1'));
  });

  it('blocks beacon mode without drand and random.org without a key', async () => {
    installFakeApi({
      'GET /api/settings': () => settings,
      'GET /api/presets': () => OFC_PRESETS,
      'GET /api/rulesets': () => [],
    });
    renderPage();
    await screen.findByTestId('preset-standard-pineapple');
    await userEvent.click(screen.getByTestId('randomness-beacon'));
    expect(screen.getByTestId('create-error')).toHaveTextContent('drand');
    await userEvent.selectOptions(screen.getByTestId('entropy-select'), 'drand');
    expect(screen.queryByTestId('create-error')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('randomness-per-draw'));
    await userEvent.selectOptions(screen.getByTestId('entropy-select'), 'random.org');
    expect(screen.getByTestId('create-error')).toHaveTextContent('API key');
  });

  it('switches to backgammon presets and sends the match config with the home side', async () => {
    let created: Record<string, unknown> | null = null;
    installFakeApi({
      'GET /api/settings': () => settings,
      'GET /api/presets': (_i, url) =>
        url.searchParams.get('game') === 'backgammon'
          ? [
              {
                id: 'money',
                name: 'Money session',
                description: '',
                config: { length: 0, crawford: false, jacoby: true },
              },
            ]
          : OFC_PRESETS,
      'GET /api/rulesets': () => [],
      'POST /api/tables': (init) => {
        created = JSON.parse(String(init.body)) as Record<string, unknown>;
        return fakeTable({ id: 'bg-1', game: 'backgammon' });
      },
    });
    renderPage();
    await screen.findByTestId('game-backgammon');
    await userEvent.click(screen.getByTestId('game-backgammon'));
    await userEvent.click(await screen.findByTestId('preset-money'));
    expect(screen.getByTestId('length-0')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByTestId('home-side-right'));
    await userEvent.click(screen.getByTestId('create-table'));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ game: 'backgammon', seats: 2, options: { homeSide: 'right' } });
    expect(created!.config).toMatchObject({ length: 0, jacoby: true, rules: 'enforced' });
  });
});

describe('NewTablePage trust disclosure', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('always describes a dealer-hosted table, per game', async () => {
    installFakeApi({
      'GET /api/settings': () => settings,
      'GET /api/presets': () => OFC_PRESETS,
      'GET /api/rulesets': () => [],
    });
    renderPage();
    const panel = await screen.findByTestId('trust-panel');
    expect(panel).toHaveAttribute('data-level', 'dealer');
    expect(panel).toHaveTextContent('Dealer-hosted');
    expect(panel).toHaveTextContent('no player at the table can see');
    await userEvent.click(screen.getByTestId('game-backgammon'));
    await waitFor(() =>
      expect(screen.getByTestId('trust-panel')).toHaveTextContent('takes no seat'),
    );
    expect(screen.getByTestId('trust-panel')).toHaveAttribute('data-level', 'dealer');
  });
});
