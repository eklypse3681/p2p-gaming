import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionRegistryProvider, useSession, useSessionRegistry } from './SessionRegistry';
import type { Session } from './session';

function fakeSession(id: string): Session {
  return {
    matchId: id,
    code: 'CODE',
    role: 'host',
    client: { getState: () => ({ status: 'joined' }) } as never,
    provider: { name: 'fake' } as never,
    dispose: vi.fn(),
  };
}

function Consumer({ slug, id, a, b }: { slug: string; id: string; a: Session; b: Session }) {
  const registry = useSessionRegistry();
  const s = useSession(slug, 'backgammon', id);
  const other = useSession('someone-else', 'backgammon', id);
  return (
    <div>
      <div data-testid="out">{s ? `have:${s === a ? 'a' : 'b'}` : 'none'}</div>
      <div data-testid="other">{other ? 'leak' : 'isolated'}</div>
      <button onClick={() => registry.add(slug, 'backgammon', a)}>add-a</button>
      <button onClick={() => registry.add(slug, 'backgammon', b)}>add-b</button>
      <button onClick={() => registry.remove(slug, 'backgammon', id)}>remove</button>
    </div>
  );
}

describe('SessionRegistry', () => {
  it('re-renders consumers when a session is added, replaced or removed, keyed by player', async () => {
    const a = fakeSession('m1');
    const b = fakeSession('m1');
    render(
      <SessionRegistryProvider>
        <Consumer slug="alice" id="m1" a={a} b={b} />
      </SessionRegistryProvider>,
    );
    expect(screen.getByTestId('out')).toHaveTextContent('none');
    await userEvent.click(screen.getByText('add-a'));
    expect(screen.getByTestId('out')).toHaveTextContent('have:a');
    expect(screen.getByTestId('other')).toHaveTextContent('isolated');
    await userEvent.click(screen.getByText('add-b'));
    expect(screen.getByTestId('out')).toHaveTextContent('have:b');
    expect(a.dispose).toHaveBeenCalled();
    await userEvent.click(screen.getByText('remove'));
    expect(b.dispose).toHaveBeenCalled();
    expect(screen.getByTestId('out')).toHaveTextContent('none');
  });
});
