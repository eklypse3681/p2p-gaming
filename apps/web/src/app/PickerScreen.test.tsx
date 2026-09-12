import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { PickerScreen } from './PickerScreen';
import { createProfile, listProfiles, resetProfilesForTests } from '../session/profiles';

function Marker() {
  const p = useParams();
  return <div data-testid="marker">{JSON.stringify(p)}</div>;
}

function renderPicker(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={<PickerScreen />} />
        <Route path="/join/:code" element={<PickerScreen />} />
        <Route path="/backgammon/join/:code" element={<PickerScreen game="backgammon" />} />
        <Route path="/:profile" element={<Marker />} />
        <Route path="/:profile/:game/join/:code" element={<Marker />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PickerScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
  });

  it('with no players shows the create form and lands on the new player after creating', async () => {
    renderPicker();
    expect(screen.queryByTestId('profile-list')).toBeNull();
    await userEvent.click(screen.getByTestId('new-profile-button'));
    expect(screen.getByTestId('new-profile-error')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('new-profile-name'), 'Dana');
    await userEvent.click(screen.getByTestId('new-profile-button'));
    expect(screen.getByTestId('marker')).toHaveTextContent('{"profile":"dana"}');
    expect(listProfiles().map((p) => p.slug)).toEqual(['dana']);
  });

  it('lists existing players and navigates to the chosen one', async () => {
    createProfile('Alice', { now: 1 });
    createProfile('Bob', { now: 2 });
    renderPicker();
    const list = screen.getByTestId('profile-list');
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId('profile-alice')).toHaveTextContent('Alice');
    expect(screen.getByTestId('profile-bob')).toHaveTextContent('#/bob/');
    await userEvent.click(screen.getByTestId('profile-alice'));
    expect(screen.getByTestId('marker')).toHaveTextContent('{"profile":"alice"}');
  });

  it('in invite mode, choosing a player joins the match as them (game-typed link)', async () => {
    createProfile('Alice');
    renderPicker('/backgammon/join/abc234');
    expect(screen.getByTestId('picker-joining')).toHaveTextContent('Backgammon match ABC234');
    await userEvent.click(screen.getByTestId('profile-alice'));
    expect(screen.getByTestId('marker')).toHaveTextContent(
      '{"profile":"alice","game":"backgammon","code":"ABC234"}',
    );
  });

  it('a legacy profile-less invite link means backgammon', async () => {
    createProfile('Alice');
    renderPicker('/join/abc234');
    await userEvent.click(screen.getByTestId('profile-alice'));
    expect(screen.getByTestId('marker')).toHaveTextContent(
      '{"profile":"alice","game":"backgammon","code":"ABC234"}',
    );
  });
});

describe('PickerScreen import', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
  });

  it('imports a pasted transfer code, creates the player with its id and navigates', async () => {
    const { encodeTransferCode } = await import('../session/transfer');
    const code = encodeTransferCode({ id: 'dana-id', name: 'Dana', avatar: '🦉', createdAt: 1 });
    renderPicker();
    await userEvent.click(screen.getByTestId('import-profile-toggle'));
    expect(screen.getByTestId('import-profile-button')).toBeDisabled();
    await userEvent.type(screen.getByTestId('import-profile-code'), code);
    await userEvent.click(screen.getByTestId('import-profile-button'));
    expect(await screen.findByTestId('marker')).toHaveTextContent('{"profile":"dana"}');
    const dana = listProfiles().find((p) => p.slug === 'dana');
    expect(dana).toMatchObject({ id: 'dana-id', name: 'Dana', avatar: '🦉' });
  });

  it('shows an error for a bad code and stays on the picker', async () => {
    renderPicker();
    await userEvent.click(screen.getByTestId('import-profile-toggle'));
    await userEvent.type(screen.getByTestId('import-profile-code'), 'p2pg1.nope');
    await userEvent.click(screen.getByTestId('import-profile-button'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent(/damaged/);
    expect(screen.queryByTestId('marker')).toBeNull();
    expect(listProfiles()).toEqual([]);
  });

  it('in invite mode an imported player goes straight to joining', async () => {
    const { encodeTransferCode } = await import('../session/transfer');
    const code = encodeTransferCode({ id: 'dana-id', name: 'Dana', avatar: '🦉', createdAt: 1 });
    renderPicker('/backgammon/join/abc234');
    await userEvent.click(screen.getByTestId('import-profile-toggle'));
    await userEvent.type(screen.getByTestId('import-profile-code'), code);
    await userEvent.click(screen.getByTestId('import-profile-button'));
    expect(await screen.findByTestId('marker')).toHaveTextContent(
      '{"profile":"dana","game":"backgammon","code":"ABC234"}',
    );
  });
});

describe('PickerScreen hand-off (?import=)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
  });

  it('imports the identity from the link and goes straight to the join', async () => {
    const { encodeIdentityCode } = await import('../session/transfer');
    const code = encodeIdentityCode({ id: 'dana-id', name: 'Dana', avatar: '🦉' });
    renderPicker(`/backgammon/join/abc234?import=${code}`);
    expect(screen.getByTestId('import-auto')).toHaveTextContent('Continuing as Dana');
    await waitFor(() => expect(screen.getByTestId('marker')).toBeInTheDocument());
    const marker = screen.getByTestId('marker').textContent ?? '';
    expect(marker).toContain('"profile":"dana"');
    expect(marker).toContain('"code":"ABC234"');
    expect(listProfiles().map((p) => [p.slug, p.id])).toEqual([['dana', 'dana-id']]);
  });

  it('merges into an existing player with the same id instead of creating a duplicate', async () => {
    const { encodeIdentityCode } = await import('../session/transfer');
    createProfile('Alice', { id: 'alice-id' });
    const code = encodeIdentityCode({ id: 'alice-id', name: 'Alice on the phone' });
    renderPicker(`/backgammon/join/abc234?import=${code}`);
    await waitFor(() => expect(screen.getByTestId('marker')).toBeInTheDocument());
    expect(screen.getByTestId('marker').textContent).toContain('"profile":"alice"');
    expect(listProfiles()).toHaveLength(1);
    expect(listProfiles()[0]!.name).toBe('Alice on the phone');
  });

  it('shows the picker with an error when the identity code is damaged', async () => {
    createProfile('Alice');
    renderPicker('/backgammon/join/abc234?import=p2pi1.garbage');
    expect(await screen.findByTestId('import-error')).toBeInTheDocument();
    expect(screen.getByTestId('profile-alice')).toBeInTheDocument();
  });
});
