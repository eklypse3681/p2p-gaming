import { useState } from 'react';
import type { TrustDescription } from '@bgf/table';
import styles from './TrustPanel.module.css';

/**
 * Trust disclosure: who can see what at a table. The panel is shown before a host creates a
 * table; the badge sits on join screens and in the game rail and opens the same details on
 * tap or hover. Levels: `open`, `host-sees-hidden`, `dealer`.
 */

export function TrustPanel({ trust }: { trust: TrustDescription }) {
  return (
    <section className={styles.panel} data-testid="trust-panel" data-level={trust.level}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          {iconFor(trust.level)}
        </span>
        <strong className={styles.title}>{trust.title}</strong>
      </div>
      <ul className={styles.details}>
        {trust.details.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export function TrustBadge({
  trust,
  compact = false,
}: {
  trust: TrustDescription;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.badgeWrap}>
      <button
        type="button"
        className={`badge ${styles.badge}`}
        data-testid="trust-badge"
        data-level={trust.level}
        title={trust.details.join(' ')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{iconFor(trust.level)}</span>
        {compact ? null : <span>{trust.title}</span>}
      </button>
      {open && (
        <div
          className={styles.popover}
          role="dialog"
          aria-label={trust.title}
          data-testid="trust-details"
        >
          <strong>{trust.title}</strong>
          <ul className={styles.details}>
            {trust.details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

function iconFor(level: TrustDescription['level']): string {
  switch (level) {
    case 'open':
      return '👁';
    case 'host-sees-hidden':
      return '🫣';
    case 'dealer':
      return '🎩';
  }
}
