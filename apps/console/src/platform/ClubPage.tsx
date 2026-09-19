import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useResource } from '../api/useApi';
import { platformApi, subscribeClubEvents } from './api';
import type { PlatformEvent } from './api';
import { isClubAdmin } from './session';
import { OverviewPanel } from './club/OverviewPanel';
import { MembersPanel } from './club/MembersPanel';
import { RequestsPanel } from './club/RequestsPanel';
import { InvitesPanel } from './club/InvitesPanel';
import { RoomsPanel } from './club/RoomsPanel';
import { TablesPanel } from './club/TablesPanel';
import { LedgerPanel } from './club/LedgerPanel';
import { StatementsPanel } from './club/StatementsPanel';

const TABS = [
  { id: 'overview', label: 'Overview', admin: false },
  { id: 'members', label: 'Members', admin: false },
  { id: 'requests', label: 'Requests', admin: true },
  { id: 'invites', label: 'Invites', admin: true },
  { id: 'rooms', label: 'Rooms & templates', admin: false },
  { id: 'tables', label: 'Live tables', admin: false },
  { id: 'ledger', label: 'Ledger', admin: true },
  { id: 'statements', label: 'Statements', admin: false },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function ClubPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, refresh, setData } = useResource(() => platformApi.club(id), id);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [live, setLive] = useState<'open' | 'error' | 'idle'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeClubEvents(
      id,
      (e) => {
        setEvents((prev) =>
          prev.some((x) => x.seq === e.seq)
            ? prev
            : [...prev.slice(-199), e].sort((a, b) => a.seq - b.seq),
        );
        // The stream replays recent events on connect; refresh once things settle.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void refresh(), 300);
      },
      (state) => setLive(state),
    );
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, refresh]);

  if (error && !data) {
    return (
      <main className="page" data-testid="club-page-error">
        <p className="error-text">{error}</p>
        <Link to="/clubs">Back to my clubs</Link>
      </main>
    );
  }
  if (!data) return <main className="page">Loading…</main>;
  const club = data;
  const admin = isClubAdmin(club.role);
  const tabs = TABS.filter((t) => admin || !t.admin);
  const requested = params.get('tab');
  const tab: TabId = tabs.some((t) => t.id === requested) ? (requested as TabId) : 'overview';
  const setTab = (next: TabId) => setParams({ tab: next }, { replace: true });
  const panel = { club, admin, refresh, setClub: setData };

  return (
    <main className="page" data-testid="club-page" data-role={club.role ?? 'none'}>
      <div className="page-head">
        <div>
          <span className="eyebrow">
            <Link to="/clubs">My clubs</Link> / Club
          </span>
          <h1>{club.name}</h1>
          <p className="muted">{club.tagline ?? `${club.currency.name} (${club.currency.code})`}</p>
        </div>
        <div className="row">
          <span className="badge" data-testid="club-role">
            {club.role ?? 'guest'}
          </span>
          <span
            className={`badge ${club.status === 'active' ? 'badge-success' : 'badge-danger'}`}
            data-testid="club-status"
          >
            <span className={`dot ${live === 'open' ? 'dot-live' : ''}`} />
            {club.status}
          </span>
          <span className="small muted" data-testid="live-indicator" data-live={live}>
            {live === 'open' ? 'live' : live === 'error' ? 'reconnecting…' : ''}
          </span>
        </div>
      </div>
      <div className="chips" role="tablist" aria-label="Club sections" data-testid="club-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className="chip"
            role="tab"
            aria-selected={tab === t.id}
            aria-checked={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
            {t.id === 'members' && club.pendingMembers > 0 ? ` (${club.pendingMembers})` : ''}
            {t.id === 'requests' && club.requests.length > 0 ? ` (${club.requests.length})` : ''}
          </button>
        ))}
      </div>
      <section data-testid={`panel-${tab}`}>
        {tab === 'overview' && <OverviewPanel {...panel} events={events} />}
        {tab === 'members' && <MembersPanel {...panel} />}
        {tab === 'requests' && <RequestsPanel {...panel} />}
        {tab === 'invites' && <InvitesPanel {...panel} />}
        {tab === 'rooms' && <RoomsPanel {...panel} />}
        {tab === 'tables' && <TablesPanel {...panel} />}
        {tab === 'ledger' && <LedgerPanel {...panel} />}
        {tab === 'statements' && <StatementsPanel {...panel} />}
      </section>
    </main>
  );
}
