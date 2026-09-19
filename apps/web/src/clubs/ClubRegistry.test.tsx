import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ClubRegistryProvider, useClubRegistry } from './ClubRegistry';
import { FakeClubClient } from './testing/FakeClubClient';
import type { ClubSession } from './session';

const profile = { id: 'ada', name: 'Ada', publicKey: 'k' };
const session = (client: FakeClubClient): ClubSession => ({
  clubId: 'c1',
  address: 'c1',
  client,
  dispose: () => client.close(),
});

describe('ClubRegistry', () => {
  it('keeps a live session and disposes a newcomer under the same key', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClubRegistryProvider>{children}</ClubRegistryProvider>
    );
    const { result } = renderHook(() => useClubRegistry(), { wrapper });
    const live = new FakeClubClient({ profile });
    const late = new FakeClubClient({ profile });
    expect(result.current.add('alice', session(live))).toBe('added');
    expect(result.current.add('alice', session(late))).toBe('kept');
    expect(late.getState().status).toBe('disconnected');
    expect(result.current.get('alice', 'c1')?.client).toBe(live);
    // A dead session is replaced.
    live.close();
    const fresh = new FakeClubClient({ profile });
    expect(result.current.add('alice', session(fresh))).toBe('added');
    expect(result.current.get('alice', 'c1')?.client).toBe(fresh);
    result.current.remove('alice', 'c1');
    expect(result.current.get('alice', 'c1')).toBeUndefined();
    expect(fresh.getState().status).toBe('disconnected');
  });
});
