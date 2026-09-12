import { motion } from 'motion/react';
import type { Player } from '@bgf/engine';
import type { CheckerStyle } from '../../themes/theme';
import { CHECKER_RADIUS, CHIP } from '../geometry';

export interface CheckerProps {
  id: string;
  player: Player;
  style: CheckerStyle;
  cx: number;
  cy: number;
  scale?: number;
  shape: 'disc' | 'chip';
  ghost?: boolean;
  recent?: boolean;
  hit?: boolean;
  /** Stack overflow badge (total count) shown on the topmost checker. */
  badge?: number;
  dragging?: boolean;
  reducedMotion?: boolean;
  testId?: string;
}

const TRANSITION = { type: 'tween', duration: 0.26, ease: [0.22, 0.61, 0.36, 1] } as const;
const DRAG_TRANSITION = { type: 'tween', duration: 0 } as const;

/** One checker. Position changes animate; hit checkers hop in an arc to the bar. */
export function Checker(props: CheckerProps) {
  const {
    id,
    player,
    style,
    cx,
    cy,
    shape,
    ghost,
    recent,
    hit,
    badge,
    dragging,
    reducedMotion,
    testId,
  } = props;
  const scale = (props.scale ?? 1) * (dragging ? 1.08 : 1);
  const r = CHECKER_RADIUS;
  const gradId = `checker-${player}`;
  const animate =
    reducedMotion || dragging || !hit
      ? { x: cx, y: cy, scale }
      : { x: [null, cx, cx], y: [null, cy - 120, cy], scale: [null, scale * 1.12, scale] };
  const transition = reducedMotion
    ? { duration: 0 }
    : dragging
      ? DRAG_TRANSITION
      : hit
        ? { duration: 0.42, ease: 'easeOut' as const }
        : TRANSITION;

  return (
    <motion.g
      data-testid={testId ?? `checker-${id}`}
      data-checker={id}
      data-player={player}
      data-ghost={ghost ? 'true' : undefined}
      data-recent={recent ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      initial={false}
      animate={animate}
      transition={transition}
      style={{ opacity: ghost ? 0.45 : 1, pointerEvents: 'none' }}
    >
      {shape === 'chip' ? (
        <g>
          <rect
            x={-CHIP.width / 2}
            y={-CHIP.height / 2}
            width={CHIP.width}
            height={CHIP.height}
            rx={CHIP.height / 2}
            fill={style.fill}
            stroke={style.edge}
            strokeWidth={2}
          />
          <rect
            x={-CHIP.width / 2 + 6}
            y={-CHIP.height / 2 + 2}
            width={CHIP.width - 12}
            height={3}
            rx={1.5}
            fill={style.sheen}
            opacity={0.55}
          />
        </g>
      ) : (
        <g>
          {!ghost && <circle r={r} cy={4} fill="rgba(0,0,0,0.35)" filter="url(#checker-shadow)" />}
          <circle r={r} fill={`url(#${gradId})`} stroke={style.edge} strokeWidth={3} />
          <circle r={r - 9} fill="none" stroke={style.edge} strokeWidth={1.2} opacity={0.35} />
          <ellipse
            cx={-r * 0.3}
            cy={-r * 0.36}
            rx={r * 0.34}
            ry={r * 0.2}
            fill={style.sheen}
            opacity={0.55}
          />
          {recent && !reducedMotion && (
            <motion.circle
              key={`${id}-${cx}-${cy}`}
              r={r}
              fill="none"
              stroke={style.sheen}
              strokeWidth={4}
              initial={{ opacity: 0.9, scale: 1 }}
              animate={{ opacity: 0, scale: 1.5 }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
            />
          )}
          {badge !== undefined && badge > 0 && (
            <g data-testid={`checker-badge-${id}`}>
              <circle r={17} fill={style.label} opacity={0.92} />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={22}
                fontWeight={700}
                fill={style.fill}
                style={{ fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)' }}
              >
                {badge}
              </text>
            </g>
          )}
        </g>
      )}
    </motion.g>
  );
}
