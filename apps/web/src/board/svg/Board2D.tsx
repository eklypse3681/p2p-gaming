import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'motion/react';
import type { Player } from '@bgf/engine';
import type { BoardLocation, BoardRendererProps, CheckerVM } from '../contract';
import { locationKey, sameLocation } from '../contract';
import {
  CHECKER_RADIUS,
  FELT_BOTTOM,
  FELT_TOP,
  MID_Y,
  VIEWBOX,
  allPointSlots,
  boardLayout,
  checkerPosition,
  clientToViewBox,
  nearestLocation,
  pointHitRect,
} from '../geometry';
import { Checker } from './Checker';
import { DiceGroup, OpeningDice } from './Dice';
import { Cube } from './Cube';
import { Labels } from './Labels';
import { Point } from './Point';
import { Bar } from './Bar';
import { Tray } from './Tray';

/** Mouse: a small dead zone so clicks never turn into drags. Touch: fingers jitter, start sooner. */
const DRAG_THRESHOLD_MOUSE = 6;
const DRAG_THRESHOLD_TOUCH = 3;
/** A drag that ends where it started, having barely moved, is a tap. */
const TAP_SLOP = 14;
const DOUBLE_TAP_MS = 320;

interface PointerTracking {
  from: BoardLocation;
  checkerId: string | null;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  dragEligible: boolean;
  active: boolean;
}

interface DragState {
  from: BoardLocation;
  checkerId: string;
  x: number;
  y: number;
}

function describe(model: BoardRendererProps['model']): string {
  const parts = ['Backgammon board.'];
  if (model.openingDice) parts.push('Opening roll in progress.');
  if (model.dice) {
    const d = model.dice.values;
    parts.push(`${model.names[model.dice.player]} to move with ${d[0]} and ${d[1]}.`);
  }
  parts.push(
    `${model.names.white} ${model.pips.white} pips, ${model.names.black} ${model.pips.black} pips.`,
  );
  return parts.join(' ');
}

function topCheckerAt(checkers: CheckerVM[], loc: BoardLocation): CheckerVM | null {
  let top: CheckerVM | null = null;
  for (const c of checkers) {
    if (!sameLocation(c.location, loc)) continue;
    if (!top || c.index > top.index) top = c;
  }
  return top;
}

/**
 * The 2D SVG renderer. Pure presentation: it draws `model` with `theme` and reports
 * pointer/keyboard intent through the callbacks. See `contract.ts`.
 *
 * Pointer handling works for mouse, pen and touch alike: pointer capture keeps a drag alive
 * when the finger leaves the element, `touch-action: none` stops the page from scrolling under
 * a drag, and drops resolve through geometry (`nearestLocation`) so a finger just outside the
 * felt still lands on the nearest point. Every drop resolves to a stack slot, never a free
 * position, so checkers can never overlap.
 */
export function Board2D(props: BoardRendererProps) {
  const {
    model,
    theme,
    onSelect,
    onDrop,
    onHover,
    onActivate,
    onDragStart,
    onDragCancel,
    reducedMotion,
    testIdPrefix,
  } = props;
  const tid = useCallback(
    (s: string) => (testIdPrefix ? `${testIdPrefix}-${s}` : s),
    [testIdPrefix],
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const tracking = useRef<PointerTracking | null>(null);
  const lastTap = useRef<{ key: string; at: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const { perspective, highlights, homeSide } = model;
  const board = theme.board;
  const layout = useMemo(() => boardLayout(homeSide), [homeSide]);

  const sourceKeys = useMemo(
    () => new Set(highlights.sources.map(locationKey)),
    [highlights.sources],
  );
  const targetKeys = useMemo(
    () => new Set(highlights.targets.map(locationKey)),
    [highlights.targets],
  );
  const combinedKeys = useMemo(
    () => new Set(highlights.combinedTargets.map(locationKey)),
    [highlights.combinedTargets],
  );
  const blockedKeys = useMemo(
    () => new Set((highlights.blocked ?? []).map(locationKey)),
    [highlights.blocked],
  );
  const selectedKey = highlights.selected ? locationKey(highlights.selected) : null;
  const invalidKey = highlights.invalid ? locationKey(highlights.invalid.location) : null;
  const hoveredKey = highlights.hovered ? locationKey(highlights.hovered) : null;

  // If the model stops being interactive mid-drag, drop the drag (adjusted during render;
  // the interaction hook clears its own `dragging` when the snapshot changes).
  if (!model.interactive && drag) setDrag(null);

  const toViewBox = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    return clientToViewBox(svg.getBoundingClientRect(), clientX, clientY);
  }, []);

  const handlePointerDown = useCallback(
    (loc: BoardLocation) => (e: ReactPointerEvent<SVGElement>) => {
      if (e.button !== undefined && e.button !== 0) return;
      const isSource = model.interactive && sourceKeys.has(locationKey(loc));
      const top = isSource ? topCheckerAt(model.checkers, loc) : null;
      tracking.current = {
        from: loc,
        checkerId: top?.id ?? null,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        dragEligible: isSource && !!top,
        active: false,
      };
      const svg = svgRef.current;
      if (svg && typeof svg.setPointerCapture === 'function') {
        try {
          svg.setPointerCapture(e.pointerId);
        } catch {
          /* not supported */
        }
      }
    },
    [model.interactive, model.checkers, sourceKeys],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const t = tracking.current;
      if (!t || t.pointerId !== e.pointerId) return;
      if (!model.interactive) {
        tracking.current = null;
        return;
      }
      if (!t.active) {
        if (!t.dragEligible) return;
        const dx = e.clientX - t.startX;
        const dy = e.clientY - t.startY;
        const threshold = t.pointerType === 'touch' ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
        if (Math.hypot(dx, dy) < threshold) return;
        t.active = true;
        onDragStart?.(t.from);
      }
      const p = toViewBox(e.clientX, e.clientY);
      if (!p || !t.checkerId) return;
      setDrag({ from: t.from, checkerId: t.checkerId, x: p.x, y: p.y });
      onHover?.(nearestLocation(p.x, p.y, perspective, homeSide));
    },
    [model.interactive, onDragStart, onHover, perspective, homeSide, toViewBox],
  );

  const finishPointer = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
      const t = tracking.current;
      if (!t || t.pointerId !== e.pointerId) return;
      tracking.current = null;
      const svg = svgRef.current;
      if (svg && typeof svg.releasePointerCapture === 'function') {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      let tap = !t.active;
      if (t.active) {
        // The dragged checker is drawn at its home slot again (or at its new slot once the
        // container applies the move); motion animates it there, so a refused drop snaps back.
        setDrag(null);
        const p = cancelled ? null : toViewBox(e.clientX, e.clientY);
        const target = p ? nearestLocation(p.x, p.y, perspective, homeSide) : null;
        const travelled = Math.hypot(e.clientX - t.startX, e.clientY - t.startY);
        if (target && sameLocation(target, t.from) && travelled < TAP_SLOP && !cancelled) {
          // A jittery finger, not a drag.
          onDragCancel?.();
          tap = true;
        } else {
          onHover?.(null);
          if (target && !sameLocation(target, t.from)) onDrop?.(t.from, target);
          else onDragCancel?.();
          return;
        }
      }
      if (cancelled || !tap) return;
      const key = locationKey(t.from);
      const now = Date.now();
      const last = lastTap.current;
      if (last && last.key === key && now - last.at < DOUBLE_TAP_MS) {
        lastTap.current = null;
        onActivate?.(t.from);
      } else {
        lastTap.current = { key, at: now };
        onSelect?.(t.from);
      }
    },
    [onActivate, onDrop, onDragCancel, onHover, onSelect, perspective, homeSide, toViewBox],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => finishPointer(e, false),
    [finishPointer],
  );
  const handlePointerCancel = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => finishPointer(e, true),
    [finishPointer],
  );

  const handleKey = useCallback(
    (loc: BoardLocation) => (e: ReactKeyboardEvent<SVGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect?.(loc);
      }
    },
    [onSelect],
  );

  const hoverIn = useCallback(
    (loc: BoardLocation) => () => {
      if (!tracking.current?.active) onHover?.(loc);
    },
    [onHover],
  );
  const hoverOut = useCallback(() => {
    if (!tracking.current?.active) onHover?.(null);
  }, [onHover]);

  const slots = useMemo(() => allPointSlots(perspective, homeSide), [perspective, homeSide]);
  const checkersByLoc = useMemo(() => {
    const m = new Map<string, CheckerVM[]>();
    for (const c of model.checkers) {
      const k = locationKey(c.location);
      const arr = m.get(k) ?? [];
      arr.push(c);
      m.set(k, arr);
    }
    return m;
  }, [model.checkers]);

  const stateOf = (loc: BoardLocation) => {
    const k = locationKey(loc);
    return {
      key: k,
      source: sourceKeys.has(k),
      target: targetKeys.has(k),
      combined: combinedKeys.has(k),
      blocked: blockedKeys.has(k),
      selected: selectedKey === k,
      invalid: invalidKey === k,
      candidate: hoveredKey === k && (targetKeys.has(k) || combinedKeys.has(k)),
    };
  };

  const focusable = (s: ReturnType<typeof stateOf>) =>
    model.interactive && (s.source || s.target || s.combined);

  const cursorFor = (s: ReturnType<typeof stateOf>) => {
    if (!model.interactive) return 'default';
    if (drag) return 'grabbing';
    if (s.selected) return 'grabbing';
    if (s.blocked) return 'not-allowed';
    if (s.source) return 'grab';
    if (s.target || s.combined) return 'pointer';
    return 'default';
  };

  // Draw checkers ordered by stack so compacted stacks overlap correctly; the dragged one last.
  const drawList = useMemo(() => {
    const list = model.checkers.slice().sort((a, b) => {
      const ka = locationKey(a.location);
      const kb = locationKey(b.location);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.index - b.index;
    });
    if (drag) {
      const i = list.findIndex((c) => c.id === drag.checkerId);
      if (i >= 0) list.push(...list.splice(i, 1));
    }
    return list;
  }, [model.checkers, drag]);

  const styleFor = (player: Player) =>
    player === 'white' ? theme.pieces.white : theme.pieces.black;

  const feltHeight = FELT_BOTTOM - FELT_TOP;
  const pulse = reducedMotion ? undefined : { opacity: [0.55, 1, 0.55] };
  const pulseTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 1.5, repeat: Infinity, ease: 'easeInOut' as const };

  /** Position of the next free slot at a location (where a dropped checker would land). */
  const dropSlot = (loc: BoardLocation) => {
    const stack = checkersByLoc.get(locationKey(loc)) ?? [];
    return checkerPosition(loc, stack.length, stack.length + 1, perspective, homeSide);
  };

  const targetMarker = (loc: BoardLocation, combined: boolean) => {
    const k = locationKey(loc);
    const pos = dropSlot(loc);
    const candidate = hoveredKey === k;
    const r = pos.shape === 'chip' ? 30 : CHECKER_RADIUS * (candidate ? 0.9 : 0.72);
    return (
      <motion.circle
        key={`target-${k}`}
        data-testid={tid(`target-${k}`)}
        data-candidate={candidate ? 'true' : undefined}
        cx={pos.cx}
        cy={pos.cy}
        r={r}
        fill={combined && !candidate ? 'none' : board.highlightTarget}
        fillOpacity={candidate ? 0.5 : 0.35}
        stroke={board.highlightTarget}
        strokeWidth={candidate ? 6 : combined ? 3 : 4}
        strokeDasharray={combined && !candidate ? '10 8' : undefined}
        initial={{ opacity: 0.55 }}
        animate={candidate ? { opacity: 1 } : (pulse ?? { opacity: 0.9 })}
        transition={candidate ? { duration: 0.12 } : pulseTransition}
        style={{ pointerEvents: 'none' }}
      />
    );
  };

  const blockedMarker = (loc: BoardLocation) => {
    const k = locationKey(loc);
    const pos = dropSlot(loc);
    const r = CHECKER_RADIUS * 0.42;
    return (
      <g
        key={`blocked-${k}`}
        data-testid={tid(`blocked-${k}`)}
        opacity={0.55}
        style={{ pointerEvents: 'none' }}
      >
        <circle cx={pos.cx} cy={pos.cy} r={r} fill="none" stroke="#e0574c" strokeWidth={4} />
        <line
          x1={pos.cx - r * 0.7}
          y1={pos.cy + r * 0.7}
          x2={pos.cx + r * 0.7}
          y2={pos.cy - r * 0.7}
          stroke="#e0574c"
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
    );
  };

  const invalidMarker = () => {
    if (!highlights.invalid) return null;
    const loc = highlights.invalid.location;
    const stack = checkersByLoc.get(locationKey(loc)) ?? [];
    const pos = checkerPosition(
      loc,
      Math.max(stack.length - 1, 0),
      Math.max(stack.length, 1),
      perspective,
      homeSide,
    );
    return (
      <motion.circle
        key={`invalid-${highlights.invalid.at}`}
        data-testid={tid('invalid-marker')}
        cx={pos.cx}
        cy={pos.cy}
        r={CHECKER_RADIUS + 6}
        fill="none"
        stroke="#e0574c"
        strokeWidth={5}
        initial={{ opacity: 1, x: 0 }}
        animate={reducedMotion ? { opacity: 0 } : { opacity: [1, 1, 0], x: [0, -8, 8, -6, 6, 0] }}
        transition={{ duration: 0.45 }}
        style={{ pointerEvents: 'none' }}
      />
    );
  };

  const hitRectProps = (loc: BoardLocation, label: string) => {
    const s = stateOf(loc);
    const isFocusable = focusable(s);
    return {
      fill: 'transparent',
      cursor: cursorFor(s),
      tabIndex: isFocusable ? 0 : -1,
      role: isFocusable ? 'button' : undefined,
      'aria-label': label,
      'data-source': s.source ? 'true' : undefined,
      'data-target': s.target ? 'true' : s.combined ? 'combined' : undefined,
      'data-blocked': s.blocked ? 'true' : undefined,
      'data-selected': s.selected ? 'true' : undefined,
      'data-candidate': s.candidate ? 'true' : undefined,
      onPointerDown: handlePointerDown(loc),
      onPointerEnter: hoverIn(loc),
      onPointerLeave: hoverOut,
      onKeyDown: handleKey(loc),
      style: { outline: 'none' } as const,
    };
  };

  const countLabel = (loc: BoardLocation) => {
    const stack = checkersByLoc.get(locationKey(loc)) ?? [];
    if (stack.length === 0) return 'empty';
    const player = stack[0]!.player;
    return `${stack.length} ${model.names[player]} checker${stack.length === 1 ? '' : 's'}`;
  };

  return (
    <svg
      ref={svgRef}
      data-testid={tid('board')}
      data-perspective={perspective}
      data-home-side={homeSide}
      data-interactive={model.interactive ? 'true' : 'false'}
      data-dragging={drag ? 'true' : undefined}
      viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={describe(model)}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={board.frame} />
          <stop offset="55%" stopColor={board.frame} stopOpacity={0.92} />
          <stop offset="100%" stopColor={board.frameEdge} />
        </linearGradient>
        <pattern
          id="wood-grain"
          width="220"
          height="18"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(2)"
        >
          <rect width="220" height="18" fill="transparent" />
          <path
            d="M0 4 Q 55 0 110 4 T 220 4"
            stroke="rgba(0,0,0,0.16)"
            strokeWidth="1.2"
            fill="none"
          />
          <path
            d="M0 13 Q 70 9 140 13 T 220 13"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
            fill="none"
          />
        </pattern>
        <radialGradient id="felt-vignette" cx="50%" cy="50%" r="75%">
          <stop offset="0%" stopColor="#fff" stopOpacity={0.06} />
          <stop offset="70%" stopColor="#000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.35} />
        </radialGradient>
        <linearGradient id="point-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#000" stopOpacity={0.18} />
          <stop offset="50%" stopColor="#fff" stopOpacity={0.05} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.22} />
        </linearGradient>
        <linearGradient id="tray-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#000" stopOpacity={0.35} />
          <stop offset="30%" stopColor="#000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.25} />
        </linearGradient>
        <radialGradient id="checker-white" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor={theme.pieces.white.sheen} stopOpacity={0.9} />
          <stop offset="35%" stopColor={theme.pieces.white.fill} />
          <stop offset="100%" stopColor={theme.pieces.white.edge} />
        </radialGradient>
        <radialGradient id="checker-black" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor={theme.pieces.black.sheen} stopOpacity={0.9} />
          <stop offset="35%" stopColor={theme.pieces.black.fill} />
          <stop offset="100%" stopColor={theme.pieces.black.edge} />
        </radialGradient>
        <filter id="checker-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="soft-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Frame */}
      <rect x={0} y={0} width={VIEWBOX.width} height={VIEWBOX.height} rx={26} fill="url(#wood)" />
      <rect
        x={0}
        y={0}
        width={VIEWBOX.width}
        height={VIEWBOX.height}
        rx={26}
        fill="url(#wood-grain)"
        opacity={0.7}
      />
      <rect
        x={6}
        y={6}
        width={VIEWBOX.width - 12}
        height={VIEWBOX.height - 12}
        rx={22}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={2}
      />

      {/* Felt */}
      {[layout.outerFelt, layout.homeFelt].map((felt) => (
        <g key={felt.x}>
          <rect x={felt.x} y={FELT_TOP} width={felt.width} height={feltHeight} fill={board.felt} />
          <rect
            x={felt.x}
            y={FELT_TOP}
            width={felt.width}
            height={feltHeight}
            fill="url(#felt-vignette)"
          />
          <rect x={felt.x} y={FELT_TOP} width={felt.width} height={6} fill="rgba(0,0,0,0.35)" />
          <rect
            x={felt.x}
            y={FELT_BOTTOM - 6}
            width={felt.width}
            height={6}
            fill="rgba(0,0,0,0.25)"
          />
        </g>
      ))}

      {/* Points */}
      <g data-testid={tid('points')}>
        {slots.map((slot) => {
          const s = stateOf({ kind: 'point', point: slot.abs });
          return (
            <Point
              key={slot.abs}
              slot={slot}
              board={board}
              source={s.source && !highlights.quiet}
              selected={s.selected}
            />
          );
        })}
      </g>

      <Bar board={board} homeSide={homeSide} />
      <Tray
        board={board}
        perspective={perspective}
        homeSide={homeSide}
        pips={model.pips}
        names={model.names}
      />
      <Labels perspective={perspective} homeSide={homeSide} board={board} />

      {/* Cube & dice (under checkers so a hit checker can cross them) */}
      <Cube
        cube={model.cube}
        perspective={perspective}
        homeSide={homeSide}
        board={board}
        reducedMotion={reducedMotion}
      />
      {model.dice && (
        <DiceGroup
          dice={model.dice}
          perspective={perspective}
          homeSide={homeSide}
          board={board}
          reducedMotion={reducedMotion}
        />
      )}
      {!model.dice && model.openingDice && (
        <OpeningDice
          opening={model.openingDice}
          perspective={perspective}
          homeSide={homeSide}
          board={board}
          reducedMotion={reducedMotion}
        />
      )}

      {/* Target / blocked markers */}
      <g data-testid={tid('targets')}>
        {highlights.targets.map((loc) => targetMarker(loc, false))}
        {highlights.combinedTargets.map((loc) => targetMarker(loc, true))}
        {(highlights.blocked ?? []).map((loc) => blockedMarker(loc))}
        {invalidMarker()}
      </g>

      {/* Checkers (the dragged one is drawn last, following the pointer) */}
      <g data-testid={tid('checkers')}>
        {drawList.map((c) => {
          const dragged = drag?.checkerId === c.id;
          const pos = dragged
            ? { cx: drag.x, cy: drag.y, scale: 1, shape: 'disc' as const }
            : checkerPosition(c.location, c.index, c.stackSize, perspective, homeSide);
          const isTop = c.index === c.stackSize - 1;
          const badge = isTop && c.stackSize > 5 && pos.shape === 'disc' ? c.stackSize : undefined;
          const s = stateOf(c.location);
          return (
            <g key={c.id} data-location={locationKey(c.location)} data-colour={c.player}>
              {isTop && s.selected && !dragged && pos.shape === 'disc' && (
                <motion.circle
                  cx={pos.cx}
                  cy={pos.cy}
                  r={CHECKER_RADIUS + 7}
                  fill="none"
                  stroke={board.highlightSelected}
                  strokeWidth={5}
                  initial={{ opacity: 0.7 }}
                  animate={pulse ?? { opacity: 0.95 }}
                  transition={pulseTransition}
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {isTop &&
                s.source &&
                !highlights.quiet &&
                !s.selected &&
                !dragged &&
                pos.shape === 'disc' && (
                  <circle
                    cx={pos.cx}
                    cy={pos.cy}
                    r={CHECKER_RADIUS + 5}
                    fill="none"
                    stroke={board.highlightSource}
                    strokeWidth={3}
                    opacity={0.8}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              <Checker
                id={c.id}
                player={c.player}
                style={styleFor(c.player)}
                cx={pos.cx}
                cy={pos.cy}
                scale={pos.scale}
                shape={pos.shape}
                ghost={c.ghost}
                recent={c.recent}
                hit={c.hit}
                badge={badge}
                dragging={dragged}
                reducedMotion={reducedMotion}
                testId={tid(`checker-${c.id}`)}
              />
            </g>
          );
        })}
      </g>

      {/* Interaction layer: transparent hit areas on top of everything. */}
      <g data-testid={tid('hit-layer')}>
        {slots.map((slot) => {
          const loc: BoardLocation = { kind: 'point', point: slot.abs };
          const r = pointHitRect(slot);
          return (
            <rect
              key={slot.abs}
              data-testid={tid(`point-${slot.abs}`)}
              data-point={slot.abs}
              data-rel={slot.display}
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              {...hitRectProps(loc, `Point ${slot.display}, ${countLabel(loc)}`)}
            />
          );
        })}
        {(['top', 'bottom'] as const).map((half) => {
          const player: Player =
            half === 'top' ? perspective : perspective === 'white' ? 'black' : 'white';
          const loc: BoardLocation = { kind: 'bar', player };
          return (
            <rect
              key={`bar-${player}`}
              data-testid={tid(`bar-${player}`)}
              x={layout.bar.x}
              y={half === 'top' ? FELT_TOP : MID_Y}
              width={layout.bar.width}
              height={MID_Y - FELT_TOP}
              {...hitRectProps(loc, `${model.names[player]} bar, ${countLabel(loc)}`)}
            />
          );
        })}
        {(['top', 'bottom'] as const).map((half) => {
          const player: Player =
            half === 'bottom' ? perspective : perspective === 'white' ? 'black' : 'white';
          const loc: BoardLocation = { kind: 'off', player };
          return (
            <rect
              key={`off-${player}`}
              data-testid={tid(`off-${player}`)}
              x={Math.min(layout.divider.x, layout.tray.x)}
              y={half === 'top' ? FELT_TOP : MID_Y}
              width={layout.divider.width + layout.tray.width}
              height={MID_Y - FELT_TOP}
              {...hitRectProps(loc, `${model.names[player]} borne off, ${countLabel(loc)}`)}
            />
          );
        })}
      </g>
    </svg>
  );
}
