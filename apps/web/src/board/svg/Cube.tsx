import { motion } from 'motion/react';
import type { Player } from '@bgf/engine';
import type { BoardSet } from '../../themes/theme';
import type { CubeVM, HomeSide } from '../contract';
import type { Geometry } from '../geometry';
import { DEFAULT_GEOMETRY } from '../geometry';

export interface CubeProps {
  /** Board layout; the classic 3:2 board when omitted. */
  geo?: Geometry;
  cube: CubeVM;
  perspective: Player;
  homeSide: HomeSide;
  board: BoardSet;
  reducedMotion?: boolean;
  /** The player may double now: the cube is a button, drawn with a soft pulsing ring. */
  pressable?: boolean;
}

/** Displayed face: a centred cube at 1 shows 64; an offered cube already shows the new value. */
export function cubeFace(cube: CubeVM): number {
  if (cube.offeredBy) return cube.value * 2;
  return cube.value === 1 && cube.owner === 'center' ? 64 : cube.value;
}

export function Cube({
  cube,
  perspective,
  homeSide,
  board,
  reducedMotion,
  pressable,
  geo = DEFAULT_GEOMETRY,
}: CubeProps) {
  const pos = geo.cubePosition(cube, perspective, homeSide);
  const half = pos.size / 2;
  const face = cubeFace(cube);
  // The cube is drawn upright for whoever it faces; when it faces the opponent, flip it.
  const rotate = pos.facing && pos.facing !== perspective ? 180 : 0;
  return (
    <motion.g
      data-testid="cube"
      data-value={face}
      data-owner={cube.owner}
      data-offered={cube.offeredBy ?? undefined}
      data-pressable={pressable ? 'true' : undefined}
      initial={false}
      animate={{ x: pos.x, y: pos.y, rotate, scale: 1 }}
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 24 }}
      style={{ pointerEvents: 'none' }}
    >
      {pressable && !cube.offeredBy && (
        <motion.rect
          x={-half - 7}
          y={-half - 7}
          width={pos.size + 14}
          height={pos.size + 14}
          rx={pos.size * 0.24}
          fill="none"
          stroke={board.highlightSource}
          strokeWidth={3}
          initial={{ opacity: 0.5 }}
          animate={reducedMotion ? { opacity: 0.7 } : { opacity: [0.25, 0.75, 0.25] }}
          transition={reducedMotion ? { duration: 0 } : { duration: 2.2, repeat: Infinity }}
        />
      )}
      {cube.offeredBy && (
        <motion.rect
          x={-half - 10}
          y={-half - 10}
          width={pos.size + 20}
          height={pos.size + 20}
          rx={pos.size * 0.26}
          fill="none"
          stroke={board.highlightSelected}
          strokeWidth={5}
          initial={{ opacity: 0.4 }}
          animate={reducedMotion ? { opacity: 0.8 } : { opacity: [0.35, 0.95, 0.35] }}
          transition={reducedMotion ? { duration: 0 } : { duration: 1.4, repeat: Infinity }}
        />
      )}
      <rect
        x={-half}
        y={-half + 5}
        width={pos.size}
        height={pos.size}
        rx={pos.size * 0.18}
        fill="rgba(0,0,0,0.4)"
      />
      <rect
        x={-half}
        y={-half}
        width={pos.size}
        height={pos.size}
        rx={pos.size * 0.18}
        fill={board.cubeFace}
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={2}
      />
      <rect
        x={-half + 4}
        y={-half + 4}
        width={pos.size - 8}
        height={pos.size * 0.4}
        rx={pos.size * 0.14}
        fill="#fff"
        opacity={0.25}
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={pos.size * 0.46}
        fontWeight={800}
        fill={board.cubeText}
        style={{ fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)' }}
      >
        {face}
      </text>
    </motion.g>
  );
}

/** A tap target over the cube, laid on top of the board's other hit areas. */
export function CubeHitArea({
  cube,
  perspective,
  homeSide,
  onClick,
  testId,
  geo = DEFAULT_GEOMETRY,
}: {
  geo?: Geometry;
  cube: CubeVM;
  perspective: Player;
  homeSide: HomeSide;
  onClick: () => void;
  testId: string;
}) {
  const pos = geo.cubePosition(cube, perspective, homeSide);
  const pad = 10;
  return (
    <rect
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-label="Offer a double"
      x={pos.x - pos.size / 2 - pad}
      y={pos.y - pos.size / 2 - pad}
      width={pos.size + pad * 2}
      height={pos.size + pad * 2}
      fill="transparent"
      style={{ cursor: 'pointer', touchAction: 'manipulation' }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    />
  );
}
