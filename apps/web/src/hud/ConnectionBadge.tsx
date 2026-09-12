import type { ClientState } from '@bgf/client';
import { opponentConnected, opponentPresent } from './derive';

export function ConnectionBadge({ state, role }: { state: ClientState; role: 'host' | 'guest' }) {
  let cls = 'badge';
  let text: string;
  if (state.status === 'connecting') {
    text = 'Connecting…';
  } else if (state.status === 'disconnected') {
    cls += ' badge-danger';
    text = role === 'host' ? 'Server stopped' : 'Disconnected from host';
  } else if (state.status === 'rejected') {
    cls += ' badge-danger';
    text = 'Rejected';
  } else if (!opponentPresent(state)) {
    text = 'Waiting for opponent';
  } else if (opponentConnected(state)) {
    cls += ' badge-success';
    text = 'Opponent online';
  } else {
    text = 'Opponent offline';
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
