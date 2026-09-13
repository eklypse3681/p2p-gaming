import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PlayerProfile, Signer } from '@bgf/protocol';
import { signerFor } from '@bgf/protocol';
import type { ProfileRecord } from './profiles';
import {
  AVATARS,
  ensureKeys,
  ensureProfile,
  getSecrets,
  isLocked,
  isValidSlug,
  lockNow,
  toPlayerProfile,
  touchProfile,
  updateProfile,
  useProfilesIndex,
} from './profiles';
import { attachSync } from './sync/registry';
import { UnlockPrompt } from './UnlockPrompt';

export interface ProfileContext {
  /** URL segment this tab plays as. */
  slug: string;
  /** What the server sees (id, name, avatar, public key). */
  profile: PlayerProfile;
  record: ProfileRecord;
  /** Signs seat challenges; null until the key pair exists (see `ready`). */
  signer: Signer | null;
  /** Resolves once the player's key pair exists: the profile to send and the signer to use. */
  ready: () => Promise<{ profile: PlayerProfile; signer: Signer | null }>;
  /** Password protection is on for this player (and this tab has unlocked it). */
  locked: boolean;
  /** Forget the unlocked secrets in this tab. */
  lockNow: () => void;
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
 * `#/<name>/` address just works; an invalid slug renders `fallback`. A password-locked player
 * shows the unlock prompt instead of its routes until this tab has unlocked it.
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
  const [, setUnlockTick] = useState(0);

  useEffect(() => {
    if (!valid) return;
    ensureProfile(slug);
    touchProfile(slug);
  }, [slug, valid]);

  // Every player owns a key pair; legacy ones get theirs on first visit (non-blocking).
  const needsKeys = !!record && !record.publicKey && !isLocked(record);
  useEffect(() => {
    if (!valid || !needsKeys) return;
    void ensureKeys(slug).catch(() => {});
  }, [slug, valid, needsKeys]);

  const secrets = record ? getSecrets(slug) : null;
  const locked = !!record && isLocked(record);
  const unlocked = !locked || secrets !== null;

  // Keep this player's devices in sync while the profile is open (honours the `sync` setting).
  useEffect(() => {
    if (!valid || !record || !unlocked) return;
    return attachSync(slug);
  }, [slug, valid, record, unlocked]);

  const privateKey = secrets?.privateKey ?? null;
  const signer = useMemo(() => (privateKey ? signerFor(privateKey) : null), [privateKey]);
  const ready = useCallback(async () => {
    const r = (await ensureKeys(slug)) ?? record;
    if (!r) throw new Error(`no player "${slug}"`);
    const s = getSecrets(slug);
    return {
      profile: toPlayerProfile(r),
      signer: s?.privateKey ? signerFor(s.privateKey) : null,
    };
  }, [slug, record]);
  const doLockNow = useCallback(() => lockNow(slug), [slug]);
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
            signer,
            ready,
            locked,
            lockNow: doLockNow,
            setName,
            setAvatar,
            avatars: AVATARS,
            path,
          }
        : null,
    [slug, record, signer, ready, locked, doLockNow, setName, setAvatar, path],
  );

  if (!valid) return <>{fallback}</>;
  if (!value || !record) return null; // created in the effect above; renders on the next tick
  if (!unlocked) {
    return (
      <div className="page page-narrow" data-testid="locked-profile">
        <UnlockPrompt
          slug={slug}
          name={record.name}
          avatar={record.avatar}
          onUnlocked={() => setUnlockTick((n) => n + 1)}
        />
      </div>
    );
  }
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
