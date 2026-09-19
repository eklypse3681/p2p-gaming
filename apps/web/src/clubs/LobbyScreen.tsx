import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { LobbyState, LobbyTable, TableTemplate } from '@bgf/protocol';
import { describeRules } from '@bgf/ofc-engine';
import type { TableConfig } from '@bgf/ofc-engine';
import { useProfile } from '../session/ProfileProvider';
import { SessionError } from '../session/session';
import type { FlowProgress } from '../session/retry';
import { gamePath } from '../games/GameProvider';
import { getGame } from '../games/registry';
import type { GameId } from '../games/ids';
import { isGameId } from '../games/ids';
import { useClubRegistry, useClubSession } from './ClubRegistry';
import { useClubState } from './useClubState';
import { connectClub } from './session';
import { getJoinedClub, updateClub } from './clubsStore';
import { formatChips, parseChips } from './money';
import { friendlyClubError, clubErrorRetryable } from './errors';
import { capabilitiesOf } from './types';
import type { ClubSeat } from './types';
import { ClubDisclosure } from './ClubDisclosure';
import { FindGame } from './FindGame';
import { forgetQueue, getQueue, rememberQueue } from './queueStore';
import { isSupported } from '@bgf/club-spec';
import type { MatchCriteria } from '@bgf/club-spec';
import styles from './clubs.module.css';

function describeTemplate(t: TableTemplate): string {
  if (t.game === 'ofc') {
    try {
      return describeRules(t.config as TableConfig);
    } catch {
      /* fall through */
    }
  }
  if (t.game === 'backgammon') {
    const c = t.config as { length?: number } | null;
    return c?.length ? `${c.length}-point match` : 'Backgammon';
  }
  return getGame(t.game)?.name ?? t.game;
}

function stakesText(t: TableTemplate, lobby: LobbyState): string {
  const cur = lobby.club.currency;
  const parts = [`${formatChips(t.stakes.chipsPerPoint, cur)} per point`];
  if (t.stakes.buyIn) {
    parts.push(
      `buy-in ${formatChips(t.stakes.buyIn.min, cur)}–${formatChips(t.stakes.buyIn.max, cur)}`,
    );
  }
  const rake = rakeText(t, lobby);
  if (rake) parts.push(rake);
  return parts.join(' · ');
}

/** Templates may carry a house rake (`rake: { percent?, cap? }`, cap in minor units); shown plainly. */
function rakeText(t: TableTemplate, lobby: LobbyState): string | null {
  const rake = (t as { rake?: { percent?: number; cap?: number } }).rake;
  if (!rake || (!rake.percent && !rake.cap)) return null;
  const parts: string[] = [];
  if (rake.percent) parts.push(`${rake.percent}% rake`);
  if (rake.cap) parts.push(`cap ${formatChips(rake.cap, lobby.club.currency)}`);
  return parts.join(', ');
}

const inflight = new Map<string, Promise<void>>();

/** `#/<profile>/club/:clubId` — rooms, tables, chips, chat and statement for one club. */
export function LobbyScreen() {
  const { clubId = '' } = useParams();
  const navigate = useNavigate();
  const { slug, path, ready, profile } = useProfile();
  const registry = useClubRegistry();
  const session = useClubSession(slug, clubId);
  const state = useClubState(session?.client ?? null);
  const client = session?.client ?? null;
  const remembered = getJoinedClub(slug, clubId);
  const [progress, setProgress] = useState<FlowProgress | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [buyIns, setBuyIns] = useState<Record<string, string>>({});
  const [showStatement, setShowStatement] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [requestAmount, setRequestAmount] = useState('');
  const [chatText, setChatText] = useState('');
  // Only a seat handed out *after* this screen mounted sends us to the table; coming back to the
  // lobby while still seated must not bounce us straight out again.
  const lastSeat = useRef<ClubSeat | null>(state?.seat ?? null);

  const status = state?.status ?? 'connecting';
  const needsConnect = !session || status === 'disconnected';

  // Connect (or reconnect) when there is no live session for this club in this tab.
  useEffect(() => {
    if (!needsConnect || !remembered) return;
    const key = `${slug}:${clubId}`;
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const { profile, signer } = await ready();
        const s = await connectClub(
          {
            slug,
            clubId,
            address: remembered.address,
            profile,
            signer: signer ?? undefined,
            invite: remembered.invite,
          },
          { onProgress: setProgress },
        );
        registry.add(slug, s);
        const lobby = s.client.getState().lobby;
        if (lobby)
          updateClub(slug, clubId, {
            name: lobby.club.name,
            currency: lobby.club.currency,
            balance: lobby.me.balance,
            lastSeen: Date.now(),
          });
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    let active = true;
    p.then(
      () => active && setConnectError(null),
      (e) =>
        active &&
        setConnectError(e instanceof SessionError ? e.message : 'Could not reach the club'),
    );
    return () => {
      active = false;
    };
  }, [needsConnect, remembered, slug, clubId, ready, registry, attempt]);

  // Matchmaking survives a reload: the ticket we asked for is remembered, and if we come back
  // with no live ticket the club is asked for the same game again.
  const ticket = state?.ticket ?? null;
  useEffect(() => {
    if (!ticket) return;
    rememberQueue(slug, {
      clubId,
      ticketId: ticket.id,
      criteria: ticket.criteria,
      queuedAt: ticket.queuedAt,
    });
  }, [ticket, slug, clubId]);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || status !== 'joined' || !client) return;
    restored.current = true;
    const saved = getQueue(slug, clubId);
    if (!saved) return;
    if (!isSupported(capabilitiesOf(state), 'matchmaking')) {
      forgetQueue(slug, clubId);
      return;
    }
    if (!state?.ticket) client.queue(saved.criteria as MatchCriteria);
  }, [status, client, slug, clubId, state]);
  useEffect(() => {
    if (state?.queueEnded) forgetQueue(slug, clubId);
  }, [state?.queueEnded, slug, clubId]);

  // A seat handed to us: remember it and go to the table.
  useEffect(() => {
    const seat = state?.seat ?? null;
    if (!seat || seat === lastSeat.current) return;
    lastSeat.current = seat;
    updateClub(slug, clubId, { lastSeen: Date.now(), balance: state?.balance ?? undefined });
    const game: GameId = isGameId(seat.game) ? seat.game : 'ofc';
    navigate(
      `${gamePath(slug, game, `/join/${seat.code}`)}?club=${encodeURIComponent(clubId)}&table=${encodeURIComponent(seat.tableId)}`,
    );
  }, [state?.seat, state?.balance, slug, clubId, navigate]);

  const lobby = state?.lobby ?? null;
  const caps = capabilitiesOf(state);
  const deferred = caps.settlement === 'deferred';
  const staked = state?.staked ?? 0;
  const currency = lobby?.club.currency ??
    remembered?.currency ?? { code: 'chips', name: 'Chips', decimals: 0 };
  const members = useMemo(() => {
    const names = new Map<string, string>();
    for (const t of lobby?.tables ?? [])
      for (const s of t.seats) if (s) names.set(s.memberId, s.name);
    for (const c of state?.chat ?? []) names.set(c.from.id, c.from.name);
    names.delete(profile.id);
    return Array.from(names, ([id, name]) => ({ id, name }));
  }, [lobby, state?.chat, profile.id]);

  if (!remembered && !session) {
    return (
      <div className="page page-narrow" data-testid="lobby-screen" data-club={clubId}>
        <div className="card">
          <h1>Unknown club</h1>
          <p className="muted">
            This player has not joined that club. Use the invite the club sent you.
          </p>
          <Link to={path('/clubs')} className="btn">
            Your clubs
          </Link>
        </div>
      </div>
    );
  }

  const sit = (t: LobbyTable | null, tpl: TableTemplate | null) => {
    if (!client) return;
    const template =
      tpl ?? lobby?.rooms.flatMap((r) => r.templates).find((x) => x.id === t?.templateId) ?? null;
    let buyIn: number | undefined;
    if (template?.stakes.buyIn) {
      const typed = buyIns[template.id];
      const parsed = typed ? parseChips(typed, currency) : template.stakes.buyIn.default;
      if (
        parsed === null ||
        parsed < template.stakes.buyIn.min ||
        parsed > template.stakes.buyIn.max
      ) {
        setConnectError(
          `Buy-in must be between ${formatChips(template.stakes.buyIn.min, currency)} and ${formatChips(template.stakes.buyIn.max, currency)}`,
        );
        return;
      }
      buyIn = parsed;
    }
    setConnectError(null);
    client.sit({
      ...(t ? { tableId: t.id } : {}),
      ...(tpl ? { templateId: tpl.id } : {}),
      ...(buyIn !== undefined ? { buyIn } : {}),
    });
  };
  const onTransfer = (e: FormEvent) => {
    e.preventDefault();
    const amount = parseChips(transferAmount, currency);
    if (!client || !transferTo || amount === null || amount <= 0) return;
    client.transfer(transferTo, amount);
    setTransferAmount('');
  };
  const onRequest = (e: FormEvent) => {
    e.preventDefault();
    const amount = parseChips(requestAmount, currency);
    if (!client || amount === null || amount <= 0) return;
    client.requestChips(amount);
    setRequestAmount('');
  };
  const onChat = (e: FormEvent) => {
    e.preventDefault();
    if (!client || !chatText.trim()) return;
    client.chat(chatText.trim());
    setChatText('');
  };

  const rejectedText = (reason: string | null) =>
    friendlyClubError(reason ?? '', 'The club refused the connection.');

  return (
    <div className="page" data-testid="lobby-screen" data-club={clubId} data-status={status}>
      <header className={styles.header}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="eyebrow">
            <Link to={path('/clubs')}>Clubs</Link> · lobby
          </div>
          <h1 data-testid="club-name">{lobby?.club.name ?? remembered?.name ?? 'Club'}</h1>
          {lobby?.club.tagline && <p className="muted">{lobby.club.tagline}</p>}
        </div>
        <div className="card" style={{ minWidth: 200 }}>
          <div className="eyebrow">{deferred ? 'Available' : 'My chips'}</div>
          <div className={styles.balance} data-testid="club-balance">
            {state?.balance !== null && state?.balance !== undefined
              ? formatChips(state.balance, currency)
              : remembered?.balance !== undefined
                ? formatChips(remembered.balance, currency)
                : '—'}
          </div>
          {deferred && staked > 0 && (
            <div className="muted small" data-testid="club-staked">
              {formatChips(staked, currency)} staked · settles when you leave
            </div>
          )}
          <div className="muted small" data-testid="club-role">
            {lobby ? `${lobby.me.member.role} · ${lobby.online.length} online` : status}
          </div>
        </div>
      </header>

      {status === 'rejected' && (
        <div className={`${styles.status} error`} role="alert" data-testid="club-rejected">
          {rejectedText(state?.rejectReason ?? null)}
        </div>
      )}
      {status !== 'joined' && status !== 'rejected' && (
        <div className={styles.status} data-testid="club-connecting">
          <span className="muted">
            {status === 'disconnected' ? 'Connection to the club lost.' : 'Connecting to the club…'}
            {progress?.attempt && progress.attempt > 1 ? ` attempt ${progress.attempt}` : ''}
          </span>
          {connectError && <span className="error">{connectError}</span>}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAttempt((n) => n + 1)}
            data-testid="club-reconnect"
          >
            Reconnect
          </button>
        </div>
      )}
      {status === 'joined' && connectError && (
        <p className="error" role="alert" data-testid="lobby-error">
          {connectError}
        </p>
      )}
      {state?.error && status === 'joined' && (
        <p className="error" role="alert" data-testid="club-error" data-code={state.error.code}>
          {friendlyClubError(state.error.code, state.error.message)}
          {clubErrorRetryable(state.error.code) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: '0.5rem' }}
              onClick={() => client?.refresh()}
              data-testid="club-error-retry"
            >
              Try again
            </button>
          )}
        </p>
      )}

      {lobby && (
        <div className={styles.two}>
          <div className="stack">
            {isSupported(caps, 'matchmaking') && (
              <FindGame
                client={client}
                state={state}
                lobby={lobby}
                currency={currency}
                onQueueChange={(criteria) => {
                  if (!criteria) forgetQueue(slug, clubId);
                }}
              />
            )}
            <section className="card">
              <h2>Open tables</h2>
              {lobby.tables.length === 0 ? (
                <p className="muted small" data-testid="tables-empty">
                  No table is open. Start one from a room below.
                </p>
              ) : (
                <div className={styles.tables} data-testid="lobby-tables">
                  {lobby.tables.map((t) => {
                    const free = t.seats.filter((s) => s === null).length;
                    const mine = t.seats.some((s) => s?.memberId === profile.id);
                    return (
                      <div
                        key={t.id}
                        className={styles.tableRow}
                        data-testid={`lobby-table-${t.id}`}
                        data-status={t.status}
                      >
                        <strong>{t.templateName}</strong>
                        <span className="muted small">{getGame(t.game)?.name ?? t.game}</span>
                        <span className={styles.seats}>
                          {t.seats.map((s, i) => (
                            <span key={i} className={`${styles.seat} ${s ? '' : styles.seatEmpty}`}>
                              {s
                                ? `${s.name} · ${formatChips(t.stacks[i] ?? 0, currency)}`
                                : 'open'}
                            </span>
                          ))}
                        </span>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!client || (free === 0 && !mine)}
                          onClick={() => sit(t, null)}
                          data-testid={`sit-${t.id}`}
                        >
                          {mine ? 'Return' : 'Sit'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {lobby.rooms.map((room) => (
              <section
                key={room.id}
                className={`card ${styles.room}`}
                data-testid={`room-${room.id}`}
              >
                <div>
                  <h2>{room.name}</h2>
                  {room.description && <p className="muted small">{room.description}</p>}
                </div>
                <div className={styles.templates}>
                  {room.templates.map((t) => (
                    <div
                      key={t.id}
                      className={`card ${styles.template}`}
                      data-testid={`template-${t.id}`}
                    >
                      <strong>
                        <span aria-hidden="true">{getGame(t.game)?.icon ?? '🎴'}</span> {t.name}
                      </strong>
                      <span className="muted small">{describeTemplate(t)}</span>
                      <span className="muted small">
                        {t.seats} seats · {stakesText(t, lobby)}
                      </span>
                      <span className={styles.form}>
                        {t.stakes.buyIn && (
                          <input
                            className="input"
                            style={{ width: 110 }}
                            aria-label={`Buy-in for ${t.name}`}
                            placeholder={String(t.stakes.buyIn.default / 10 ** currency.decimals)}
                            value={buyIns[t.id] ?? ''}
                            onChange={(e) => setBuyIns({ ...buyIns, [t.id]: e.target.value })}
                            data-testid={`buyin-${t.id}`}
                          />
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={!client}
                          onClick={() => sit(null, t)}
                          data-testid={`open-template-${t.id}`}
                        >
                          Open a table
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="stack">
            <ClubDisclosure capabilities={caps} />
            {(isSupported(caps, 'request-chips') ||
              isSupported(caps, 'transfer') ||
              isSupported(caps, 'statement')) && (
              <section className="card">
                <h2>Chips</h2>
                {isSupported(caps, 'request-chips') && (
                  <form className={styles.form} onSubmit={onRequest}>
                    <input
                      className="input"
                      style={{ width: 110 }}
                      placeholder="amount"
                      aria-label="Request amount"
                      value={requestAmount}
                      onChange={(e) => setRequestAmount(e.target.value)}
                      data-testid="request-amount"
                    />
                    <button
                      type="submit"
                      className="btn btn-sm"
                      disabled={!client}
                      data-testid="request-chips-button"
                    >
                      Request chips
                    </button>
                  </form>
                )}
                {isSupported(caps, 'transfer') && (
                  <form
                    className={styles.form}
                    onSubmit={onTransfer}
                    style={{ marginTop: '0.5rem' }}
                  >
                    <select
                      className="input"
                      aria-label="Transfer to"
                      value={transferTo}
                      onChange={(e) => setTransferTo(e.target.value)}
                      data-testid="transfer-to"
                    >
                      <option value="">Member…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input"
                      style={{ width: 110 }}
                      placeholder="amount"
                      aria-label="Transfer amount"
                      value={transferAmount}
                      onChange={(e) => setTransferAmount(e.target.value)}
                      data-testid="transfer-amount"
                    />
                    <button
                      type="submit"
                      className="btn btn-sm"
                      disabled={!client || !transferTo}
                      data-testid="transfer-button"
                    >
                      Transfer
                    </button>
                  </form>
                )}
                {isSupported(caps, 'statement') && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: '0.5rem' }}
                    onClick={() => {
                      setShowStatement((v) => !v);
                      if (!showStatement) client?.statement();
                    }}
                    data-testid="statement-button"
                  >
                    {showStatement ? 'Hide statement' : 'Statement'}
                  </button>
                )}
                {showStatement && (
                  <div className={styles.entries} data-testid="club-statement">
                    {!state?.statement ? (
                      <span className="muted small">Loading…</span>
                    ) : state.statement.entries.length === 0 ? (
                      <span className="muted small">No entries yet.</span>
                    ) : (
                      (() => {
                        let running = 0;
                        return state.statement.entries.map((e) => {
                          const mine = e.lines
                            .filter((l) => l.account === profile.id)
                            .reduce((a, l) => a + l.amount, 0);
                          running += mine;
                          return (
                            <div
                              key={e.seq}
                              className={styles.entry}
                              data-testid={`statement-entry-${e.seq}`}
                              data-kind={e.kind}
                            >
                              <span>
                                {e.kind}
                                {e.ref?.note ? ` · ${e.ref.note}` : ''}
                                {e.ref?.tableId
                                  ? ` · ${e.ref.game ?? 'table'} ${e.ref.hand ? `hand ${e.ref.hand}` : ''}`
                                  : ''}
                              </span>
                              <span className={mine >= 0 ? styles.pos : styles.neg}>
                                {formatChips(mine, currency, { sign: true })}
                              </span>
                              <span className="muted">{formatChips(running, currency)}</span>
                            </div>
                          );
                        });
                      })()
                    )}
                    {state?.statement && (
                      <span className="muted small" data-testid="statement-balance">
                        Balance now: {formatChips(state.statement.balance, currency)}
                      </span>
                    )}
                  </div>
                )}
              </section>
            )}

            {isSupported(caps, 'chat') && (
              <section className="card">
                <h2>Chat</h2>
                <div className={styles.chat} data-testid="club-chat">
                  {(state?.chat ?? []).length === 0 ? (
                    <span className="muted small">Say hello 👋</span>
                  ) : (
                    state!.chat.map((m, i) => (
                      <div key={i} className={styles.msg} data-testid="club-chat-message">
                        <strong>{m.from.name}</strong> <span>{m.text}</span>
                      </div>
                    ))
                  )}
                </div>
                <form className={styles.form} onSubmit={onChat} style={{ marginTop: '0.5rem' }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="Message…"
                    aria-label="Chat message"
                    value={chatText}
                    onChange={(e) => setChatText(e.target.value)}
                    data-testid="club-chat-input"
                  />
                  <button
                    type="submit"
                    className="btn btn-sm"
                    disabled={!client}
                    data-testid="club-chat-send"
                  >
                    Send
                  </button>
                </form>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
