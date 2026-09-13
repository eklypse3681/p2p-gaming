import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { PlayerProfile } from '@bgf/protocol';
import type { ProfileRecord } from './profiles';
import {
  AVATARS,
  ensureProfile,
  isValidSlug,
  toPlayerProfile,
  touchProfile,
  updateProfile,
  useProfilesIndex,
} from './profiles';
import { attachSync } from './sync/registry';

export interface ProfileContext {
  /** URL segment this tab plays as. */
  slug: string;
  /** What the server sees. */
  profile: PlayerProfile;
  record: ProfileRecord;
  setName: (name: string) => void;
  setAvatar: (avatar: string) => void;
  avatars: readonly string[];
  /** Build a route inside this profile: `path('/host')` → `/steve/host`. */
  path: (sub?: string) => string;
}

const Ctx = createContext<ProfileContext | null>(null);

export function profilePath(slug: string, sub = '/'): string {
  return `/${slug}${sub.startsWith('/') ? sub : `/${sub}`}`;
}

/**
 * Provides the profile named by `slug`. An unknown (valid) slug is created on the spot so any
 * `#/<name>/` address just works; an invalid slug renders `fallback`.
 */
export function ProfileProvider({
  slug,
  children,
  fallback = null,
}: {
  slug: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const valid = isValidSlug(slug);
  const index = useProfilesIndex();
  const record = valid ? (index[slug] ?? null) : null;

  useEffect(() => {
    if (!valid) return;
    ensureProfile(slug);
    touchProfile(slug);
  }, [slug, valid]);

  // Keep this player's devices in sync while the profile is open (honours the `sync` setting).
  useEffect(() => {
    if (!valid || !record) return;
    return attachSync(slug);
  }, [slug, valid, record]);

  const setName = useCallback((name: string) => updateProfile(slug, { name }), [slug]);
  const setAvatar = useCallback((avatar: string) => updateProfile(slug, { avatar }), [slug]);
  const path = useCallback((sub?: string) => profilePath(slug, sub), [slug]);

  const value = useMemo<ProfileContext | null>(
    () =>
      record
        ? {
            slug,
            profile: toPlayerProfile(record),
            record,
            setName,
            setAvatar,
            avatars: AVATARS,
            path,
          }
        : null,
    [slug, record, setName, setAvatar, path],
  );

  if (!valid) return <>{fallback}</>;
  if (!value) return null; // created in the effect above; renders on the next tick
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProfile(): ProfileContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProfile must be used inside a profile route (ProfileProvider)');
  return ctx;
}

export function useOptionalProfile(): ProfileContext | null {
  return useContext(Ctx);
}

/** `link('/history')` → `/steve/history` for the current profile. */
export function useProfileLink(): (sub?: string) => string {
  return useProfile().path;
}
