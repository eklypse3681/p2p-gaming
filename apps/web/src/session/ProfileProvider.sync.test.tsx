import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const attach = vi.fn(() => () => {});
vi.mock('./sync/registry', () => ({ attachSync: (slug: string) => attach(slug) }));

import { ProfileProvider } from './ProfileProvider';
import { createProfile, resetProfilesForTests, touchProfile } from './profiles';

describe('ProfileProvider and sync', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
    attach.mockClear();
  });

  it('attaches sync once and keeps it attached when the profile record changes', () => {
    createProfile('Alice');
    render(
      <ProfileProvider slug="alice">
        <div />
      </ProfileProvider>,
    );
    const attachedBefore = attach.mock.calls.length;
    expect(attachedBefore).toBeGreaterThan(0);
    // Opening pages touches the record; that must not restart sync (and its connections).
    act(() => touchProfile('alice', Date.now() + 60_000));
    act(() => touchProfile('alice', Date.now() + 120_000));
    expect(attach.mock.calls.length).toBe(attachedBefore);
  });
});
