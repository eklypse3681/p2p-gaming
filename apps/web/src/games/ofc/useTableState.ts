import { useCallback, useSyncExternalStore } from 'react';
import type { TableClientState } from '@bgf/table';

/** Subscribe a component to a table client's state. */
export function useTableState<V, A, Cfg>(client: {
  getState(): TableClientState<V, A, Cfg>;
  subscribe(listener: () => void): () => void;
}): TableClientState<V, A, Cfg> {
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getState(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
