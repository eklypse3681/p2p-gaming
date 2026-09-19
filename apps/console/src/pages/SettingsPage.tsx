import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PublicSettings, StatusResponse } from '../api/client';
import { describeError } from '../api/useApi';
import { useToast } from '../components/Toast';

export function SettingsPage({
  status,
  onSaved,
}: {
  status: StatusResponse | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api
      .settings()
      .then(setForm)
      .catch((e) => toast(describeError(e), 'error'));
  }, [toast]);
  if (!form) return <main className="page">Loading…</main>;
  const set = <K extends keyof PublicSettings>(k: K, v: PublicSettings[K]) =>
    setForm({ ...form, [k]: v });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const next = await api.updateSettings({
        appUrl: form.appUrl,
        dealerName: form.dealerName,
        defaultEntropy: form.defaultEntropy,
        defaultRandomness: form.defaultRandomness,
        consoleToken: form.consoleToken,
        ...(key ? { randomOrgApiKey: key } : {}),
      });
      setForm(next);
      setKey('');
      toast('Settings saved');
      onSaved();
    } catch (err) {
      toast(describeError(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="page" data-testid="settings-page">
      <div>
        <span className="eyebrow">Settings</span>
        <h1>Dealer settings</h1>
      </div>
      <form className="two-col" onSubmit={save}>
        <div className="stack">
          <section className="card stack">
            <h2>This dealer</h2>
            <label className="field">
              <span className="label">Dealer name</span>
              <input
                className="input"
                value={form.dealerName}
                onChange={(e) => set('dealerName', e.target.value)}
                data-testid="dealer-name"
              />
              <span className="help">What players see at the table for the house.</span>
            </label>
            <label className="field">
              <span className="label">Web app URL</span>
              <input
                className="input"
                value={form.appUrl}
                onChange={(e) => set('appUrl', e.target.value)}
                data-testid="app-url"
              />
              <span className="help">
                Invite links point here. Use your own deployment if you host one.
              </span>
            </label>
            <label className="field">
              <span className="label">Console token</span>
              <input
                className="input"
                value={form.consoleToken}
                onChange={(e) => set('consoleToken', e.target.value)}
                data-testid="console-token"
                placeholder="empty = none (localhost only)"
              />
              <span className="help">
                Required for every request when the console is reachable from other machines (
                <code>dealer serve --host 0.0.0.0</code>).
              </span>
            </label>
          </section>
          <section className="card stack">
            <h2>Randomness defaults</h2>
            <label className="field">
              <span className="label">Source</span>
              <select
                className="select"
                value={form.defaultEntropy}
                onChange={(e) =>
                  set('defaultEntropy', e.target.value as PublicSettings['defaultEntropy'])
                }
                data-testid="default-entropy"
              >
                <option value="crypto">This machine (crypto)</option>
                <option value="random.org">random.org (signed)</option>
                <option value="drand">drand beacon</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Mode</span>
              <select
                className="select"
                value={form.defaultRandomness}
                onChange={(e) =>
                  set('defaultRandomness', e.target.value as PublicSettings['defaultRandomness'])
                }
                data-testid="default-randomness"
              >
                <option value="per-draw">Per draw (just in time)</option>
                <option value="seeded">Seeded hands (commit, then reveal)</option>
                <option value="beacon">Beacon rounds (drand)</option>
              </select>
            </label>
            <label className="field">
              <span className="label">random.org API key</span>
              <input
                className="input"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={form.hasRandomOrgKey ? `saved (${form.randomOrgApiKey})` : 'not set'}
                data-testid="random-org-key"
                autoComplete="off"
              />
              <span className="help">
                Stored only in this dealer's data folder; a free key allows 1,000 signed requests a
                day.
              </span>
            </label>
          </section>
          <div className="row">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={saving}
              data-testid="save-settings"
            >
              Save settings
            </button>
          </div>
        </div>
        <aside className="stack">
          <section className="card stack">
            <h2>About this dealer</h2>
            <dl className="kv">
              <dt>Data folder</dt>
              <dd className="mono small">{status?.dataDir ?? '…'}</dd>
              <dt>Listening on</dt>
              <dd className="mono small">{status ? `${status.host}:${status.port}` : '…'}</dd>
              <dt>Dealer id</dt>
              <dd className="mono small">{status?.dealer.id ?? '…'}</dd>
              <dt>Version</dt>
              <dd>{status?.version ?? '…'}</dd>
            </dl>
            <p className="help">
              The dealer holds every table's full state. Keep the process running during a hand;
              stopped tables resume with <code>dealer serve --resume-all</code> or from the Tables
              page.
            </p>
            {status && (
              <a
                className="btn btn-sm"
                href={status.settings.appUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the web app ↗
              </a>
            )}
          </section>
        </aside>
      </form>
    </main>
  );
}
