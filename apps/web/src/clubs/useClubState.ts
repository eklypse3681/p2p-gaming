import { useSyncExternalStore } from 'react';
import type { ClubClientApi, ClubClientState } from './types';

export function useClubState(client: ClubClientApi | null): ClubClientState | null {
  return useSyncExternalStore(
    (l) => (client ? client.subscribe(l) : () => {}),
    () => (client ? client.getState() : null),
    () => (client ? client.getState() : null),
  );
}
