import type { CSSProperties } from 'react';
import { parseCard } from '@bgf/ofc-engine';
import { useSettings } from '../../session/settings';
import type { OfcTrayOrder } from '../../session/settings';
import { Switch, SettingRow } from '../../app/settingsParts';
import { Card } from './cards/Card';
import styles from '../../app/SettingsScreen.module.css';

const PREVIEW = ['Ac', 'Kd', 'Qh', 'Js'].map(parseCard);

/** Open Face Chinese Poker's own settings: how the cards read and how a hand arrives. */
export function OfcSettings() {
  const [settings, update] = useSettings();
  return (
    <section className={`card ${styles.section}`} data-testid="ofc-settings">
      <h2>Cards</h2>
      <div
        className={styles.cardPreview}
        style={{ '--card-w-md': '52px' } as CSSProperties}
        aria-hidden="true"
      >
        {PREVIEW.map((c) => (
          <Card key={`${c.rank}${c.suit}`} card={c} size="md" fourColor={settings.ofcFourColor} />
        ))}
      </div>
      <SettingRow
        title="Four-colour deck"
        hint="Clubs green and diamonds blue, so a flush draw never hides in two colours."
      >
        <Switch
          on={settings.ofcFourColor}
          onChange={(v) => update({ ofcFourColor: v })}
          label="Four-colour deck"
        />
      </SettingRow>
      <SettingRow
        title="Group dealt cards by suit"
        hint="Suits together (♣ ♦ ♥ ♠), ranked inside each; off sorts by rank alone. The tray's buttons still change it per hand."
      >
        <Switch
          on={settings.ofcTraySuits}
          onChange={(v) => update({ ofcTraySuits: v })}
          label="Group dealt cards by suit"
        />
      </SettingRow>
      <SettingRow title="Rank order" hint="Highest first or lowest first.">
        <select
          className="select"
          style={{ width: 'auto' }}
          value={settings.ofcTrayOrder}
          onChange={(e) => update({ ofcTrayOrder: e.target.value as OfcTrayOrder })}
          data-testid="ofc-tray-order"
        >
          <option value="high">Highest first (A→2)</option>
          <option value="low">Lowest first (2→A)</option>
        </select>
      </SettingRow>
    </section>
  );
}
