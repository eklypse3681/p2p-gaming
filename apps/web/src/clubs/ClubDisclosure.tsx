import { useState } from 'react';
import type { ClubCapabilities } from '@bgf/club-spec';
import { describeCustody, describeMembership, describeSettlement } from '@bgf/club-spec';
import styles from './clubs.module.css';

/**
 * Who holds your chips, when they move, and how you get in — the club-level twin of the table
 * trust panel. Shown before a player commits to a club, not buried in settings, because the
 * answer differs between a club the platform hosts, one a friend runs on their laptop, and one
 * backed by a contract.
 */

function iconFor(kind: ClubCapabilities['custody']['kind']): string {
  switch (kind) {
    case 'hosted':
      return '🏛️';
    case 'self-hosted':
      return '🏠';
    case 'contract':
      return '⛓️';
    case 'local':
      return '🧪';
  }
}

export function ClubDisclosure({ capabilities }: { capabilities: ClubCapabilities }) {
  const custody = describeCustody(capabilities.custody);
  return (
    <section
      className={styles.disclosure}
      data-testid="club-disclosure"
      data-custody={capabilities.custody.kind}
      data-settlement={capabilities.settlement}
      data-membership={capabilities.membership}
    >
      <div className={styles.disclosureHead}>
        <span aria-hidden="true">{iconFor(capabilities.custody.kind)}</span>
        <strong>{custody.title}</strong>
      </div>
      <ul className={styles.disclosureList}>
        <li data-testid="disclosure-custody">{custody.detail}</li>
        <li data-testid="disclosure-settlement">{describeSettlement(capabilities)}</li>
        <li data-testid="disclosure-membership">{describeMembership(capabilities)}</li>
        {capabilities.minRakeBasisPoints ? (
          <li data-testid="disclosure-rake">
            The house takes at least {(capabilities.minRakeBasisPoints / 100).toFixed(2)}% of each
            pot.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** The compact form, for a club card or a lobby header. */
export function ClubDisclosureBadge({ capabilities }: { capabilities: ClubCapabilities }) {
  const [open, setOpen] = useState(false);
  const custody = describeCustody(capabilities.custody);
  const lines = [
    custody.detail,
    describeSettlement(capabilities),
    describeMembership(capabilities),
  ];
  return (
    <span className={styles.badgeWrap}>
      <button
        type="button"
        className={`badge ${styles.disclosureBadge}`}
        data-testid="club-disclosure-badge"
        data-custody={capabilities.custody.kind}
        title={lines.join(' ')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{iconFor(capabilities.custody.kind)}</span>
        <span>{custody.title}</span>
      </button>
      {open && (
        <div
          className={styles.disclosurePopover}
          role="dialog"
          aria-label={custody.title}
          data-testid="club-disclosure-details"
        >
          <ul className={styles.disclosureList}>
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
