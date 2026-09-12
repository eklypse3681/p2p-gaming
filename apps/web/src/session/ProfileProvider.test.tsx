import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileProvider, useProfile, useOptionalProfile } from './ProfileProvider';
import { createProfile, getProfile, resetProfilesForTests } from './profiles';

function Show() {
  const { slug, profile, path } = useProfile();
  return (
    <div data-testid="show">
      {slug}|{profile.name}|{path('/history')}
    </div>
  );
}

function Optional() {
  const ctx = useOptionalProfile();
  return <div data-testid="opt">{ctx ? ctx.slug : 'none'}</div>;
}

describe('ProfileProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProfilesForTests();
  });

  it('provides a known player and profile-scoped paths', () => {
    createProfile('Alice');
    render(
      <ProfileProvider slug="alice">
        <Show />
      </ProfileProvider>,
    );
    expect(screen.getByTestId('show')).toHaveTextContent('alice|Alice|/alice/history');
  });

  it('auto-creates an unknown slug with a pretty name and a fresh id', async () => {
    render(
      <ProfileProvider slug="eve-2">
        <Show />
      </ProfileProvider>,
    );
    expect(await screen.findByTestId('show')).toHaveTextContent('eve-2|Eve 2|/eve-2/history');
    expect(getProfile('eve-2')?.id).toBeTruthy();
  });

  it('renders the fallback for an invalid slug', () => {
    render(
      <ProfileProvider slug="Nope!" fallback={<div data-testid="fallback" />}>
        <Show />
      </ProfileProvider>,
    );
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('show')).toBeNull();
  });

  it('useOptionalProfile is null outside a profile and useProfile throws', () => {
    render(<Optional />);
    expect(screen.getByTestId('opt')).toHaveTextContent('none');
    expect(() => render(<Show />)).toThrow(/inside a profile route/);
  });
});
