import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  forgetClub,
  getJoinedClub,
  listJoinedClubs,
  rememberClub,
  updateClub,
  useJoinedClubs,
} from './clubsStore';

const cur = { code: 'chips', name: 'Chips', decimals: 0 };

describe('joined clubs store', () => {
  beforeEach(() => localStorage.clear());

  it('remembers, updates and forgets clubs per player', () => {
    rememberClub('alice', { clubId: 'c1', name: 'One', address: 'c1', currency: cur, lastSeen: 1 });
    rememberClub('alice', { clubId: 'c2', name: 'Two', address: 'c2', currency: cur, lastSeen: 2 });
    rememberClub('bob', { clubId: 'c9', name: 'Nine', address: 'c9', currency: cur, lastSeen: 3 });
    expect(listJoinedClubs('alice').map((c) => c.clubId)).toEqual(['c2', 'c1']);
    expect(listJoinedClubs('bob').map((c) => c.clubId)).toEqual(['c9']);
    updateClub('alice', 'c1', { balance: 42, lastSeen: 10 });
    expect(getJoinedClub('alice', 'c1')?.balance).toBe(42);
    expect(listJoinedClubs('alice')[0]?.clubId).toBe('c1');
    forgetClub('alice', 'c2');
    expect(listJoinedClubs('alice').map((c) => c.clubId)).toEqual(['c1']);
  });

  it('the hook re-renders on changes', () => {
    const { result } = renderHook(() => useJoinedClubs('alice'));
    expect(result.current).toEqual([]);
    act(() =>
      rememberClub('alice', {
        clubId: 'c1',
        name: 'One',
        address: 'c1',
        currency: cur,
        lastSeen: 1,
      }),
    );
    expect(result.current.map((c) => c.name)).toEqual(['One']);
  });
});
