import { createContext, useContext } from 'react';
import type { StatusResponse } from '../api/client';
import type { ClubRole, Me } from './api';

export interface PlatformSession {
  status: StatusResponse | null;
  me: Me | null;
  /** True while a stored token is being checked against `/api/me`. */
  loading: boolean;
  refreshMe: () => Promise<Me | null>;
  /** Stores the session token and loads `/api/me`. */
  signIn: (token: string) => Promise<Me | null>;
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<PlatformSession>({
  status: null,
  me: null,
  loading: false,
  refreshMe: async () => null,
  signIn: async () => null,
  signOut: async () => {},
});

export function useSession(): PlatformSession {
  return useContext(SessionContext);
}

/** Owners, admins and platform operators manage the club. */
export function isClubAdmin(role: ClubRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'operator';
}
