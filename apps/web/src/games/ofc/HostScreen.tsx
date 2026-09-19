import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TableConfig } from '@bgf/ofc-engine';
import { ofcDefinition } from '@bgf/ofc-engine';
import { describeTrust } from '@bgf/table';
import { TrustPanel } from '../../hud/TrustPanel';
import { useProfile } from '../../session/ProfileProvider';
import { useGame } from '../GameProvider';
import { getTransportName } from '../../session/providers';
import { SessionError } from '../../session/session';
import { useSessionRegistry } from '../../session/SessionRegistry';
import { hostOfcTable, ofcDeps } from './session';
import { RulesEditor } from './rules/RulesEditor';
import { DEFAULT_PRESET_ID, getPreset } from './rules/presets';
import { describeRules } from './rules/describe';
import { HostTableOptions, useHostTableChoice } from '../../hud/HostTableOptions';
import { randomnessOptions, randomnessProblem } from '../../session/entropy';
import styles from '../backgammon/HostScreen.module.css';

export function HostScreen() {
  const navigate = useNavigate();
  const registry = useSessionRegistry();
  const { profile, slug, ready } = useProfile();
  const { path, id: gameId } = useGame();
  const [config, setConfig] = useState<TableConfig>(() => getPreset(DEFAULT_PRESET_ID)!.config);
  const [table, setTable] = useHostTableChoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transport = getTransportName();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = randomnessProblem(table.randomness);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { profile, signer } = await ready();
      const session = await hostOfcTable(
        {
          profile,
          signer: signer ?? undefined,
          config,
          dealer: table.dealer,
          randomness: table.randomness,
          autopilot: !table.manualDealing,
        },
        ofcDeps(slug),
      );
      registry.add(slug, gameId, session);
      navigate(path(`/game/${session.matchId}`), { replace: true });
    } catch (err) {
      setError(err instanceof SessionError ? err.message : 'Could not create the table');
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow" data-testid="host-screen" data-game={gameId}>
      <form className={`card ${styles.form}`} onSubmit={submit}>
        <div>
          <div className="eyebrow">Host</div>
          <h1>New table</h1>
          <p className="muted">
            Your browser deals and keeps the ledger. Keep this tab open while you play.
          </p>
        </div>

        <p className="muted small" data-testid="host-as">
          Hosting as <span aria-hidden="true">{profile.avatar}</span>{' '}
          <strong>{profile.name}</strong>
        </p>

        <RulesEditor value={config} onChange={setConfig} slug={slug} />

        <HostTableOptions
          value={table}
          onChange={setTable}
          dealerHelp={`All ${config.seats} seats are taken by the players who join; this device deals, keeps the ledger and plays no hand. The safe home for seeded randomness.`}
        />
        <TrustPanel
          trust={describeTrust(ofcDefinition, {
            hostSeat: table.dealer ? null : 0,
            randomness: randomnessOptions(table.randomness),
          })}
        />

        {error && (
          <div className="error-text" role="alert" data-testid="host-error">
            {error}
          </div>
        )}

        <div className={styles.footer}>
          <button
            className="btn btn-primary btn-lg"
            type="submit"
            disabled={busy}
            data-testid="create-table-button"
          >
            {busy ? 'Setting up the table…' : 'Create table'}
          </button>
          <Link to={path('/')} className="btn btn-ghost">
            Cancel
          </Link>
          <span className="help" data-testid="host-rules-summary">
            {describeRules(config)} · transport <code>{transport}</code>
          </span>
        </div>
      </form>
    </div>
  );
}
