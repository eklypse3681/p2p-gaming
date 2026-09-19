import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { BaseSession, SessionRegistry } from './SessionRegistry';
import { SessionRegistryProvider, useSessionRegistry } from './SessionRegistry';

function fakeSession(id: string, code: string, status: 'joined' | 'connecting' | 'disconnected') {
  const dispose = vi.fn();
  const s: BaseSession = {
    matchId: id,
    code,
    role: 'host',
    client: { getState: () => ({ status }), subscribe: () => () => {} },
    dispose,
  };
  return { s, dispose };
}

function grab(): Promise<SessionRegistry> {
  return new Promise((resolve) => {
    function Probe() {
      const reg = useSessionRegistry();
      resolve(reg);
      return null;
    }
    render(
      <SessionRegistryProvider>
        <Probe />
      </SessionRegistryProvider>,
    );
  });
}

describe('SessionRegistry keeps live sessions', () => {
  it('a late newcomer never replaces a joined session: it is disposed and "kept" is returned', async () => {
    const reg = await grab();
    const live = fakeSession('m1', 'CODE01', 'joined');
    const late = fakeSession('m1', 'CODE01', 'joined');
    expect(reg.add('alice', 'ofc', live.s)).toBe('added');
    expect(reg.add('alice', 'ofc', late.s)).toBe('kept');
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(live.dispose).not.toHaveBeenCalled();
    expect(reg.get('alice', 'ofc', 'm1')).toBe(live.s);
    expect(reg.liveByCode('CODE01')).toBe(live.s);
    expect(reg.liveByCode('NOPE00')).toBeUndefined();
  });

  it('a connecting session is protected too; a dead one is replaced', async () => {
    const reg = await grab();
    const connecting = fakeSession('m2', 'CODE02', 'connecting');
    const other = fakeSession('m2', 'CODE02', 'joined');
    reg.add('alice', 'backgammon', connecting.s);
    expect(reg.add('alice', 'backgammon', other.s)).toBe('kept');
    const dead = fakeSession('m3', 'CODE03', 'disconnected');
    const fresh = fakeSession('m3', 'CODE03', 'joined');
    reg.add('alice', 'backgammon', dead.s);
    expect(reg.add('alice', 'backgammon', fresh.s)).toBe('added');
    expect(dead.dispose).toHaveBeenCalledTimes(1);
    expect(reg.get('alice', 'backgammon', 'm3')).toBe(fresh.s);
    expect(reg.liveByCode('CODE03')).toBe(fresh.s);
  });
});
