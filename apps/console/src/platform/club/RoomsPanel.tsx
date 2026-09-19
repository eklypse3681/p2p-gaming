import { useState } from 'react';
import type { ClubCurrency, Room, TableTemplate } from '@bgf/protocol';
import { describeError } from '../../api/useApi';
import { useToast } from '../../components/Toast';
import { GAME_ICON, GAME_NAME } from '../../pages/TablesPage';
import { platformApi } from '../api';
import { bpsToPercent, fmtChips } from '../format';
import type { PanelProps } from './panel';
import { TemplateForm } from './TemplateForm';

export function describeTemplate(t: TableTemplate, currency: ClubCurrency): string {
  const parts = [GAME_NAME[t.game] ?? t.game, `${t.seats} seats`];
  parts.push(
    t.stakes.chipsPerPoint > 0 ? `${fmtChips(t.stakes.chipsPerPoint, currency)}/pt` : 'points only',
  );
  if (t.stakes.buyIn)
    parts.push(
      `buy-in ${fmtChips(t.stakes.buyIn.min, currency)}–${fmtChips(t.stakes.buyIn.max, currency)}`,
    );
  parts.push(
    t.stakes.rake
      ? `rake ${bpsToPercent(t.stakes.rake.basisPoints)}${
          t.stakes.rake.cap !== undefined ? ` cap ${fmtChips(t.stakes.rake.cap, currency)}` : ''
        }`
      : 'no rake',
  );
  if (t.randomness) parts.push(`${t.randomness.mode} / ${t.randomness.provider}`);
  return parts.join(' · ');
}

export function RoomsPanel({ club, admin, refresh }: PanelProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rename, setRename] = useState<{ id: string; name: string; description: string } | null>(
    null,
  );
  const [editing, setEditing] = useState<{ roomId: string; template?: TableTemplate } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await refresh();
      return true;
    } catch (e) {
      toast(describeError(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const addRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run(
      () =>
        platformApi.addRoom(club.id, {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      'Room added',
    );
    if (ok) {
      setName('');
      setDescription('');
    }
  };
  const saveRename = async () => {
    if (!rename) return;
    const ok = await run(
      () =>
        platformApi.updateRoom(club.id, rename.id, {
          name: rename.name.trim(),
          description: rename.description.trim(),
        }),
      'Room renamed',
    );
    if (ok) setRename(null);
  };
  const deleteRoom = (room: Room) => {
    if (!window.confirm(`Delete room ${room.name} and its ${room.templates.length} templates?`))
      return;
    void run(() => platformApi.deleteRoom(club.id, room.id), 'Room deleted');
  };
  const deleteTemplate = (t: TableTemplate) => {
    if (!window.confirm(`Delete template ${t.name}?`)) return;
    void run(() => platformApi.deleteTemplate(club.id, t.id), 'Template deleted');
  };

  return (
    <div className="stack" data-testid="rooms-panel">
      {admin && (
        <form
          className="card row"
          onSubmit={addRoom}
          data-testid="room-form"
          style={{ alignItems: 'flex-end' }}
        >
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            <span className="label">Room name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="Main room"
              data-testid="room-name"
            />
          </label>
          <label className="field" style={{ flex: 2, minWidth: 220 }}>
            <span className="label">Description (optional)</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              data-testid="room-description"
            />
          </label>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !name.trim()}
            data-testid="add-room"
          >
            Add room
          </button>
        </form>
      )}
      {club.rooms.length === 0 && (
        <div className="card" data-testid="no-rooms">
          <p>
            No rooms yet. A room groups table templates; members pick a template in the lobby and
            the platform deals the table.
          </p>
        </div>
      )}
      {club.rooms.map((room) => (
        <section key={room.id} className="card stack" data-testid={`room-${room.id}`}>
          <div className="card-title" style={{ flexWrap: 'wrap' }}>
            {rename?.id === room.id ? (
              <div className="row" data-testid={`room-rename-form-${room.id}`}>
                <input
                  className="input"
                  value={rename.name}
                  onChange={(e) => setRename({ ...rename, name: e.target.value })}
                  data-testid={`room-rename-name-${room.id}`}
                  style={{ width: 200 }}
                />
                <input
                  className="input"
                  value={rename.description}
                  onChange={(e) => setRename({ ...rename, description: e.target.value })}
                  placeholder="description"
                  data-testid={`room-rename-description-${room.id}`}
                  style={{ width: 260 }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void saveRename()}
                  disabled={busy || !rename.name.trim()}
                  data-testid={`room-rename-save-${room.id}`}
                >
                  Save
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setRename(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div>
                <h2>{room.name}</h2>
                {room.description && <p className="small muted">{room.description}</p>}
              </div>
            )}
            {admin && (
              <div className="row">
                <button
                  className="btn btn-sm"
                  onClick={() => setEditing({ roomId: room.id })}
                  data-testid={`add-template-${room.id}`}
                >
                  Add template
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setRename({ id: room.id, name: room.name, description: room.description ?? '' })
                  }
                  data-testid={`rename-room-${room.id}`}
                >
                  Rename
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => deleteRoom(room)}
                  disabled={busy}
                  data-testid={`delete-room-${room.id}`}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          {room.templates.length === 0 ? (
            <p className="small muted">No templates in this room.</p>
          ) : (
            <div className="seatlist" data-testid={`template-list-${room.id}`}>
              {room.templates.map((t) => (
                <div
                  key={t.id}
                  className="seat"
                  data-testid={`template-${t.id}`}
                  data-game={t.game}
                  style={{ flexWrap: 'wrap' }}
                >
                  <span aria-hidden="true">{GAME_ICON[t.game] ?? '🎮'}</span>
                  <span className="name">{t.name}</span>
                  <span className="small muted">{describeTemplate(t, club.currency)}</span>
                  {t.alwaysOpen && <span className="badge badge-accent">always open</span>}
                  {admin && (
                    <span className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => setEditing({ roomId: room.id, template: t })}
                        data-testid={`edit-template-${t.id}`}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => deleteTemplate(t)}
                        disabled={busy}
                        data-testid={`delete-template-${t.id}`}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {editing?.roomId === room.id && (
            <TemplateForm
              key={editing.template?.id ?? 'new'}
              club={club}
              roomId={room.id}
              initial={editing.template}
              onSaved={async () => {
                setEditing(null);
                await refresh();
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </section>
      ))}
    </div>
  );
}
