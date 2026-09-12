import { useCallback, useSyncExternalStore } from 'react';
import type { ClientState, GameClientApi } from '@bgf/client';

/** Subscribe a component to a client's state (methods are bound: GameClient relies on `this`). */
export function useClientState(client: GameClientApi): ClientState {
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getState(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
