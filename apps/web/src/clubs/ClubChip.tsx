import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useProfile } from '../session/ProfileProvider';
import { useClubSession } from './ClubRegistry';
import { useClubState } from './useClubState';
import { useClubContext } from './useClubContext';
import { getJoinedClub } from './clubsStore';
import { formatChips } from './money';
import { capabilitiesOf } from './types';
import styles from './ClubChip.module.css';

/**
 * Shown on a game screen that was entered from a club lobby: which club, my balance, my stack on
 * this table, a way back, and "Leave table" which cashes the stack out to the balance. Renders
 * nothing outside a club context.
 */
export function ClubChip() {
  const ctx = useClubContext();
  const { slug, path } = useProfile();
  const navigate = useNavigate();
  const session = useClubSession(slug, ctx?.clubId);
  const state = useClubState(session?.client ?? null);
  // Leaving: chips travel back to the balance; keep the player informed until the club confirms
  // (a balance change or the seat clearing), then return to the lobby.
  const [leaving, setLeaving] = useState<{ balanceBefore: number | null } | null>(null);
  const balanceNow = state?.balance ?? null;
  const seatNow = state?.seat ?? null;
  useEffect(() => {
    if (!leaving || !ctx) return;
    if (balanceNow !== leaving.balanceBefore || seatNow === null) {
      const t = setTimeout(() => {
        setLeaving(null);
        navigate(path(`/club/${ctx.clubId}`));
      }, 400);
      return () => clearTimeout(t);
    }
    const giveUp = setTimeout(() => setLeaving(null), 8000);
    return () => clearTimeout(giveUp);
  }, [leaving, balanceNow, seatNow, ctx, navigate, path]);
  if (!ctx) return null;
  const remembered = getJoinedClub(slug, ctx.clubId);
  const lobby = state?.lobby ?? null;
  const currency = lobby?.club.currency ?? remembered?.currency ?? null;
  const name = lobby?.club.name ?? remembered?.name ?? 'Club';
  const table = ctx.tableId ? lobby?.tables.find((t) => t.id === ctx.tableId) : undefined;
  const mySeat = table
    ? table.seats.findIndex((s) => s?.memberId === state?.lobby?.me.member.id)
    : -1;
  const stack = table && mySeat >= 0 ? table.stacks[mySeat] : state?.seat?.buyIn;
  const balance = state?.balance ?? remembered?.balance;
  const canLeave = !!ctx.tableId && !!session && state?.status === 'joined';
  const deferred = capabilitiesOf(state).settlement === 'deferred';
  const settlement = state?.settlement ?? null;
  return (
    <div
      className={styles.chip}
      data-testid="club-chip"
      data-club={ctx.clubId}
      data-status={state?.status ?? 'offline'}
    >
      <span className={styles.icon} aria-hidden="true">
        🏛️
      </span>
      <span className={styles.body}>
        <strong>{name}</strong>
        <span className="muted small">
          {currency && balance !== undefined && balance !== null ? (
            <>
              {deferred ? 'available' : 'balance'}{' '}
              <span data-testid="club-chip-balance">{formatChips(balance, currency)}</span>
            </>
          ) : (
            'connecting…'
          )}
          {currency && stack !== undefined && stack !== null ? (
            <>
              {' · '}
              {deferred ? 'staked' : 'on table'}{' '}
              <span data-testid="club-chip-stack">{formatChips(stack, currency)}</span>
            </>
          ) : null}
          {deferred && (
            <span data-testid="club-chip-settlement-note"> · settles when you leave</span>
          )}
        </span>
      </span>
      {leaving ? (
        <span className="muted small" data-testid="cashing-out" role="status">
          Cashing out…
          {settlement && currency && (
            <span data-testid="club-chip-settled">
              {' '}
              settled{' '}
              {formatChips(settlement.balances[state?.lobby?.me.member.id ?? ''] ?? 0, currency)}
            </span>
          )}
        </span>
      ) : (
        <>
          {canLeave && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setLeaving({ balanceBefore: balanceNow });
                session!.client.leave(ctx.tableId!);
              }}
              data-testid="leave-table"
              title="Cash out and go back to the lobby"
            >
              Leave table
            </button>
          )}
          <Link
            to={path(`/club/${ctx.clubId}`)}
            className="btn btn-ghost btn-sm"
            data-testid="back-to-lobby"
          >
            Lobby
          </Link>
        </>
      )}
    </div>
  );
}
