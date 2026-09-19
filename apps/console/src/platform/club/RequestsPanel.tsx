import { useState } from 'react';
import type { ChipRequest } from '@bgf/protocol';
import { describeError } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { platformApi } from '../api';
import { fmtChips, fmtDate, shortId } from '../format';
import type { PanelProps } from './panel';

export function RequestsPanel({ club, refresh }: PanelProps) {
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => club.members.find((m) => m.id === id)?.name ?? shortId(id);
  const resolve = async (r: ChipRequest, decision: 'granted' | 'declined') => {
    setBusy(true);
    try {
      const note = notes[r.id]?.trim();
      await platformApi.resolveRequest(club.id, r.id, { decision, ...(note ? { note } : {}) });
      toast(`Request ${decision}`);
      await refresh();
    } catch (e) {
      toast(describeError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" data-testid="requests-panel">
      <div className="card-title">
        <h2>Chip requests</h2>
        <span className="small muted">{club.requests.length} pending</span>
      </div>
      {club.requests.length === 0 ? (
        <p className="small muted" data-testid="no-requests">
          No pending requests.
        </p>
      ) : (
        <div className="seatlist" data-testid="request-list">
          {club.requests.map((r) => (
            <div
              key={r.id}
              className="seat"
              data-testid={`request-${r.id}`}
              style={{ flexWrap: 'wrap' }}
            >
              <span className="name">{nameOf(r.memberId)}</span>
              <span className="mono">{fmtChips(r.amount, club.currency)}</span>
              {r.note && <span className="small muted">“{r.note}”</span>}
              <span className="small muted">{fmtDate(r.at)}</span>
              <input
                className="input input-sm"
                placeholder="note"
                value={notes[r.id] ?? ''}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                data-testid={`request-note-${r.id}`}
                style={{ width: 200, textAlign: 'left' }}
              />
              <button
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void resolve(r, 'granted')}
                data-testid={`grant-request-${r.id}`}
              >
                Grant
              </button>
              <button
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => void resolve(r, 'declined')}
                data-testid={`decline-request-${r.id}`}
              >
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="help">
        Members ask for chips from the web app. Granting moves the amount from the reserve to the
        member and tells them; declining only tells them.
      </p>
    </section>
  );
}
