import type { CSSProperties } from 'react';
import { parseCard } from '@bgf/ofc-engine';
import { OFC_TRAY_SORTS, useSettings } from '../../session/settings';
import type { OfcTraySort } from '../../session/settings';
import { Switch, SettingRow } from '../../app/settingsParts';
import { Card } from './cards/Card';
import styles from '../../app/SettingsScreen.module.css';

const PREVIEW = ['Ac', 'Kd', 'Qh', 'Js'].map(parseCard);

const SORT_LABELS: Record<OfcTraySort, string> = {
  dealt: 'As dealt',
  low: 'Lowest first (2→A)',
  high: 'Highest first (A→2)',
  suit: 'By suit',
};

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
        title="Sort dealt cards"
        hint="How new cards are laid out in your tray. The buttons there still change it."
      >
        <select
          className="select"
          style={{ width: 'auto' }}
          value={settings.ofcTraySort}
          onChange={(e) => update({ ofcTraySort: e.target.value as OfcTraySort })}
          data-testid="ofc-tray-sort"
        >
          {OFC_TRAY_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </SettingRow>
    </section>
  );
}
