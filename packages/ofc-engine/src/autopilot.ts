import type { AutopilotContext, AutopilotDecision } from '@bgf/table';
import { flowConfig } from './rules.js';
import { settleRequests } from './table.js';
import type { Command, TableConfig, TableState } from './types.js';

/**
 * What an unattended table does between hands. The table core asks after every action,
 * readiness change and presence change; every answer is idempotent (once applied, the same
 * state yields null).
 *
 *   lobby, every seat taken (and present)             → deal the first hand
 *   showdown, everyone asked to settle                 → settle
 *   showdown, nextHand 'ready', everyone ready         → deal the next hand
 *   showdown, nextHand 'countdown'                     → deal after `nextHandDelayMs`
 *   a hand is being set, the table is over, absent players (with pauseWhenAbsent) → nothing
 */
export function ofcAutopilot(
  state: TableState,
  ctx: AutopilotContext<TableConfig>,
): AutopilotDecision<Command> | null {
  if (state.status === 'over') return null;
  const flow = flowConfig(state.config);
  const seats = state.config.seats;
  const filled = ctx.seatsFilled.slice(0, seats).every(Boolean) && ctx.seatsFilled.length >= seats;
  const present = ctx.present.slice(0, seats).every(Boolean) && ctx.present.length >= seats;
  const roomReady = filled && (present || !flow.pauseWhenAbsent) && ctx.dealerPresent;
  const hand = state.hand;
  if (hand && hand.phase === 'setting') return null;
  if (!hand) {
    if (flow.startWhenFull && roomReady) {
      return { command: { type: 'start' }, reason: 'every seat is taken: dealing the first hand' };
    }
    return null;
  }
  // Between hands (showdown): settle first if everyone asked, then the next hand.
  if (flow.settleOnConsensus) {
    const requests = settleRequests(state);
    const active = requests.slice(0, seats);
    if (active.length === seats && active.every(Boolean)) {
      return { command: { type: 'settle' }, reason: 'everyone asked to settle' };
    }
  }
  if (!roomReady) return null;
  if (flow.nextHand === 'countdown') {
    return {
      command: { type: 'start' },
      afterMs: Math.max(0, flow.nextHandDelayMs),
      reason: `next hand in ${Math.round(flow.nextHandDelayMs / 1000)} s`,
    };
  }
  const ready = ctx.ready.slice(0, seats);
  if (ready.length === seats && ready.every(Boolean)) {
    return { command: { type: 'start' }, reason: 'everyone is ready: dealing the next hand' };
  }
  return null;
}
