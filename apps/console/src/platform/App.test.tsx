import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';
import { FakeEventSource, installFakeApi } from '../test/fakeApi';
import { dealerStatus, platformStatus } from '../test/platformFixtures';

describe('App mode switch', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.location.hash = '#/';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the platform console when status says mode: platform', async () => {
    installFakeApi({ 'GET /api/status': () => platformStatus() });
    render(<App />);
    expect(await screen.findByTestId('platform-app')).toBeInTheDocument();
    expect(screen.getByTestId('brand')).toHaveTextContent('Platform console');
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('tables-page')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-line')).toHaveTextContent('1 club · dev');
    // Remembered, so the next load renders the platform shell before status answers.
    expect(localStorage.getItem('console-mode')).toBe('platform');
  });

  it('keeps the dealer console when status has no mode', async () => {
    installFakeApi({ 'GET /api/status': () => dealerStatus(), 'GET /api/tables': () => [] });
    render(<App />);
    expect(await screen.findByTestId('tables-page')).toBeInTheDocument();
    expect(screen.getByTestId('brand')).toHaveTextContent('Dealer console');
    expect(screen.getByTestId('nav-new')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-app')).not.toBeInTheDocument();
    expect(localStorage.getItem('console-mode')).toBeNull();
  });
});
