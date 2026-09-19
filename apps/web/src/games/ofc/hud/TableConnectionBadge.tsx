import type { TableClientState } from '@bgf/table';

/** Connection summary for a table of N seats. */
export function TableConnectionBadge({
  state,
  role,
}: {
  state: TableClientState<unknown, unknown, unknown>;
  role: 'host' | 'guest';
}) {
  let cls = 'badge';
  let text: string;
  const seats = state.snapshot?.seats ?? [];
  const filled = seats.filter((s) => s !== null).length;
  const others = seats.map((_, i) => i).filter((i) => i !== state.seat && seats[i] !== null);
  const online = others.filter((i) => state.presence[i]).length;
  if (state.status === 'connecting') {
    text = 'Connecting…';
  } else if (state.status === 'disconnected') {
    cls += ' badge-danger';
    text = role === 'host' ? 'Server stopped' : 'Disconnected from host';
  } else if (state.status === 'rejected') {
    cls += ' badge-danger';
    text = 'Rejected';
  } else if (filled < seats.length) {
    text = `Waiting for players (${filled}/${seats.length})`;
  } else if (online === others.length && others.length > 0) {
    cls += ' badge-success';
    text = others.length === 1 ? 'Opponent online' : 'Everyone online';
  } else if (online > 0) {
    text = `${online} of ${others.length} online`;
  } else {
    text = others.length === 1 ? 'Opponent offline' : 'Others offline';
  }
  return (
    <span className={cls} data-testid="connection-badge" title={`You are the ${role}`}>
      {text}
      {state.latencyMs != null && state.status === 'joined' && role === 'guest'
        ? ` · ${state.latencyMs} ms`
        : ''}
    </span>
  );
}
