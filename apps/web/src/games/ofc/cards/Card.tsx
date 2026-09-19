import type { Card as CardT, Suit } from '@bgf/ofc-engine';
import { cardKey, rankChar } from '@bgf/ofc-engine';
import styles from './Card.module.css';

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

export interface CardProps {
  card?: CardT;
  /** Render the back (hidden card). */
  faceDown?: boolean;
  size?: CardSize;
  /** Clubs green, diamonds blue (four-colour deck). */
  fourColor?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  /** Small count badge on a face-down stack. */
  badge?: number;
  testId?: string;
  className?: string;
  onClick?: () => void;
  'aria-label'?: string;
}

const SUIT_GLYPH: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const SUIT_NAME: Record<Suit, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

export function suitColor(suit: Suit, fourColor: boolean): string {
  if (fourColor) {
    return {
      c: 'var(--card-clubs, #2f9e5b)',
      d: 'var(--card-diamonds, #2f6fd6)',
      h: 'var(--card-red, #d33c3c)',
      s: 'var(--card-black, #1c1f2a)',
    }[suit];
  }
  return suit === 'd' || suit === 'h' ? 'var(--card-red, #d33c3c)' : 'var(--card-black, #1c1f2a)';
}

export function cardLabel(card: CardT): string {
  const r =
    card.rank === 14
      ? 'ace'
      : card.rank === 13
        ? 'king'
        : card.rank === 12
          ? 'queen'
          : card.rank === 11
            ? 'jack'
            : String(card.rank);
  return `${r} of ${SUIT_NAME[card.suit]}`;
}

/** Face-down card back drawn from the theme accent. */
function Back({ badge }: { badge?: number }) {
  return (
    <svg viewBox="0 0 100 140" className={styles.svg} aria-hidden="true">
      <defs>
        <pattern
          id="ofc-card-back"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="12" height="12" fill="var(--card-back-bg, var(--ui-surface-raised))" />
          <rect width="6" height="12" fill="var(--card-back-fg, var(--ui-accent))" opacity="0.28" />
        </pattern>
      </defs>
      <rect
        x="1"
        y="1"
        width="98"
        height="138"
        rx="9"
        fill="var(--card-face, #fbfaf6)"
        stroke="var(--card-edge, #b8b2a4)"
        strokeWidth="1.5"
      />
      <rect
        x="8"
        y="8"
        width="84"
        height="124"
        rx="6"
        fill="url(#ofc-card-back)"
        stroke="var(--card-back-fg, var(--ui-accent))"
        strokeWidth="1.5"
      />
      {badge !== undefined && badge > 1 && (
        <g>
          <circle
            cx="50"
            cy="70"
            r="17"
            fill="var(--ui-surface)"
            stroke="var(--ui-accent)"
            strokeWidth="2"
          />
          <text
            x="50"
            y="76"
            textAnchor="middle"
            fontSize="18"
            fontWeight="700"
            fill="var(--ui-text)"
            fontFamily="var(--ui-font-mono)"
          >
            {badge}
          </text>
        </g>
      )}
    </svg>
  );
}

/** A playing card as inline SVG. Size comes from the `--card-w` custom property of its container. */
export function Card(props: CardProps) {
  const {
    card,
    faceDown,
    size = 'md',
    fourColor = false,
    selected,
    dimmed,
    badge,
    testId,
    className,
    onClick,
  } = props;
  const classes = [
    styles.card,
    styles[size],
    selected ? styles.selected : '',
    dimmed ? styles.dimmed : '',
    onClick ? styles.clickable : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  if (faceDown || !card) {
    return (
      <div
        className={classes}
        data-testid={testId ?? 'card-back'}
        data-face="down"
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        aria-label={props['aria-label'] ?? 'face-down card'}
      >
        <Back badge={badge} />
      </div>
    );
  }
  const color = suitColor(card.suit, fourColor);
  const glyph = SUIT_GLYPH[card.suit];
  const rank = rankChar(card.rank);
  return (
    <div
      className={classes}
      data-testid={testId ?? `card-${cardKey(card)}`}
      data-card={cardKey(card)}
      data-face="up"
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={props['aria-label'] ?? cardLabel(card)}
      aria-pressed={onClick ? !!selected : undefined}
    >
      <svg viewBox="0 0 100 140" className={styles.svg} aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="98"
          height="138"
          rx="9"
          fill="var(--card-face, #fbfaf6)"
          stroke="var(--card-edge, #b8b2a4)"
          strokeWidth="1.5"
        />
        <text
          x="9"
          y="30"
          fontSize="26"
          fontWeight="700"
          fill={color}
          fontFamily="var(--ui-font-mono)"
        >
          {rank}
        </text>
        <text x="9" y="52" fontSize="22" fill={color}>
          {glyph}
        </text>
        <text
          x="91"
          y="130"
          fontSize="26"
          fontWeight="700"
          fill={color}
          fontFamily="var(--ui-font-mono)"
          transform="rotate(180 91 122)"
        >
          {rank}
        </text>
        <text x="91" y="108" fontSize="22" fill={color} transform="rotate(180 91 100)">
          {glyph}
        </text>
        <text x="50" y="92" textAnchor="middle" fontSize="52" fill={color}>
          {glyph}
        </text>
      </svg>
    </div>
  );
}

/** A stack of face-down cards with a count (hidden pending cards, discards, Fantasyland rows). */
export function HiddenStack({
  count,
  size = 'sm',
  testId,
  label,
}: {
  count: number;
  size?: CardSize;
  testId?: string;
  label?: string;
}) {
  if (count <= 0) return null;
  return (
    <div
      className={styles.stack}
      data-testid={testId}
      data-count={count}
      aria-label={label ?? `${count} hidden cards`}
    >
      {Array.from({ length: Math.min(count, 3) }, (_, i) => (
        <div key={i} className={styles.stackLayer} style={{ '--i': i } as React.CSSProperties}>
          <Card
            faceDown
            size={size}
            badge={i === Math.min(count, 3) - 1 ? count : undefined}
            testId="card-back"
          />
        </div>
      ))}
    </div>
  );
}
