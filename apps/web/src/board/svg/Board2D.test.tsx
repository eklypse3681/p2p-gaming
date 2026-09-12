import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startingBoard, pipCount } from '@bgf/engine';
import type { Player } from '@bgf/engine';
import { Board2D } from './Board2D';
import { getTheme } from '../../themes';
import type { BoardViewModel, CheckerVM } from '../contract';
import { createTracker, stacked } from '../checkerTracker';
import { sampleViewModel } from '../BoardDemo';

const theme = getTheme('midnight');

afterEach(cleanup);

function startingModel(
  perspective: Player,
  overrides: Partial<BoardViewModel> = {},
): BoardViewModel {
  const board = startingBoard();
  const checkers: CheckerVM[] = stacked(createTracker(board)).map((c) => ({
    id: c.id,
    player: c.player,
    location: c.location,
    index: c.index,
    stackSize: c.stackSize,
  }));
  return {
    perspective,
    homeSide: 'right',
    checkers,
    dice: { player: 'white', values: [3, 1], used: [false, false], rollToken: 7 },
    openingDice: null,
    cube: { value: 1, owner: 'center' },
    highlights: {
      sources: [
        { kind: 'point', point: 8 },
        { kind: 'point', point: 6 },
      ],
      selected: null,
      targets: [],
      combinedTargets: [],
      invalid: null,
    },
    interactive: true,
    pips: { white: pipCount(board, 'white'), black: pipCount(board, 'black') },
    names: { white: 'Ada', black: 'Grace' },
    ...overrides,
  };
}

describe('Board2D', () => {
  it('renders 24 points labelled in the perspective player numbering', () => {
    const { unmount } = render(<Board2D model={startingModel('white')} theme={theme} />);
    for (let abs = 1; abs <= 24; abs++) {
      expect(screen.getByTestId(`point-${abs}`)).toHaveAttribute('data-rel', String(abs));
      expect(screen.getByTestId(`point-label-${abs}`)).toHaveTextContent(String(abs));
    }
    unmount();
    render(<Board2D model={startingModel('black')} theme={theme} />);
    for (let abs = 1; abs <= 24; abs++) {
      expect(screen.getByTestId(`point-${abs}`)).toHaveAttribute('data-rel', String(25 - abs));
      expect(screen.getByTestId(`point-label-${abs}`)).toHaveTextContent(String(25 - abs));
    }
    expect(screen.getByTestId('board')).toHaveAttribute('data-perspective', 'black');
  });

  it('renders 30 checkers for the starting position with correct stacks', () => {
    render(<Board2D model={startingModel('white')} theme={theme} />);
    const checkers = screen.getByTestId('checkers').querySelectorAll('[data-checker]');
    expect(checkers).toHaveLength(30);
    expect(screen.getByTestId('checkers').querySelectorAll('[data-player="white"]')).toHaveLength(
      15,
    );
    expect(screen.getByTestId('point-6')).toHaveAttribute('aria-label', 'Point 6, 5 Ada checkers');
    expect(screen.getByTestId('point-19')).toHaveAttribute(
      'aria-label',
      'Point 19, 5 Grace checkers',
    );
    expect(screen.getByTestId('point-3')).toHaveAttribute('aria-label', 'Point 3, empty');
    expect(screen.getByTestId('bar-white')).toBeInTheDocument();
    expect(screen.getByTestId('bar-black')).toBeInTheDocument();
    expect(screen.getByTestId('off-white')).toBeInTheDocument();
    expect(screen.getByTestId('off-black')).toBeInTheDocument();
    expect(screen.getByTestId('board')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Ada to move with 3 and 1'),
    );
  });

  it('shows dice and the cube with the conventional face', () => {
    render(<Board2D model={startingModel('white')} theme={theme} />);
    expect(screen.getByTestId('dice')).toHaveAttribute('data-player', 'white');
    expect(screen.getByTestId('die-0')).toHaveAttribute('data-value', '3');
    expect(screen.getByTestId('die-1')).toHaveAttribute('data-value', '1');
    expect(screen.getByTestId('cube')).toHaveAttribute('data-value', '64');
  });

  it('shows four dice for doubles and marks used ones; offered cube shows the new value', () => {
    render(
      <Board2D
        model={startingModel('white', {
          dice: { player: 'black', values: [4, 4], used: [true, true, false, false], rollToken: 9 },
          cube: { value: 2, owner: 'white', offeredBy: 'white' },
        })}
        theme={theme}
      />,
    );
    expect(screen.getByTestId('die-3')).toHaveAttribute('data-value', '4');
    expect(screen.getByTestId('die-0')).toHaveAttribute('data-used', 'true');
    expect(screen.getByTestId('die-2')).not.toHaveAttribute('data-used');
    expect(screen.getByTestId('cube')).toHaveAttribute('data-value', '4');
    expect(screen.getByTestId('cube')).toHaveAttribute('data-offered', 'white');
  });

  it('shows opening dice per side when no turn dice exist', () => {
    render(
      <Board2D
        model={startingModel('white', { dice: null, openingDice: { white: 5, ties: 0 } })}
        theme={theme}
      />,
    );
    expect(screen.getByTestId('die-white')).toHaveAttribute('data-value', '5');
    expect(screen.queryByTestId('die-black')).toBeNull();
  });

  it('reports clicks on points with the absolute location', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Board2D model={startingModel('black')} theme={theme} onSelect={onSelect} />);
    await user.click(screen.getByTestId('point-8'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'point', point: 8 });
    await user.click(screen.getByTestId('bar-white'));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'bar', player: 'white' });
    await user.click(screen.getByTestId('off-black'));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'off', player: 'black' });
  });

  it('reports a quick double tap as activate', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(
      <Board2D
        model={startingModel('white')}
        theme={theme}
        onSelect={onSelect}
        onActivate={onActivate}
      />,
    );
    await user.dblClick(screen.getByTestId('point-8'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({ kind: 'point', point: 8 });
  });

  it('makes sources and targets keyboard focusable and Enter selects', () => {
    const onSelect = vi.fn();
    render(
      <Board2D
        model={startingModel('white', {
          highlights: {
            sources: [{ kind: 'point', point: 8 }],
            selected: { kind: 'point', point: 8 },
            targets: [{ kind: 'point', point: 5 }],
            combinedTargets: [{ kind: 'point', point: 4 }],
            invalid: null,
          },
        })}
        theme={theme}
        onSelect={onSelect}
      />,
    );
    const p8 = screen.getByTestId('point-8');
    const p5 = screen.getByTestId('point-5');
    expect(p8).toHaveAttribute('tabindex', '0');
    expect(p8).toHaveAttribute('data-selected', 'true');
    expect(p5).toHaveAttribute('tabindex', '0');
    expect(p5).toHaveAttribute('data-target', 'true');
    expect(screen.getByTestId('point-4')).toHaveAttribute('data-target', 'combined');
    expect(screen.getByTestId('point-3')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('target-p5')).toBeInTheDocument();
    fireEvent.keyDown(p5, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ kind: 'point', point: 5 });
    fireEvent.keyDown(p8, { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'point', point: 8 });
  });

  it('marks ghost checkers, overflow badges and invalid flashes', () => {
    const model = startingModel('white');
    const ghostId = model.checkers.find((c) => c.player === 'black')!.id;
    model.checkers = model.checkers.map((c) => (c.id === ghostId ? { ...c, ghost: true } : c));
    // pile 7 white checkers on point 6 to trigger the badge
    const extra = model.checkers
      .filter((c) => c.player === 'white' && c.location.kind === 'point' && c.location.point === 13)
      .slice(0, 2);
    model.checkers = model.checkers.map((c) =>
      extra.includes(c) ? { ...c, location: { kind: 'point', point: 6 } } : c,
    );
    const on6 = model.checkers.filter((c) => c.location.kind === 'point' && c.location.point === 6);
    model.checkers = model.checkers.map((c) => {
      const i = on6.indexOf(c);
      return i >= 0 ? { ...c, index: i, stackSize: on6.length } : c;
    });
    model.highlights.invalid = { location: { kind: 'point', point: 3 }, at: 1 };
    render(<Board2D model={model} theme={theme} reducedMotion />);
    expect(screen.getByTestId(`checker-${ghostId}`)).toHaveAttribute('data-ghost', 'true');
    const top = on6[on6.length - 1]!;
    expect(screen.getByTestId(`checker-badge-${top.id}`)).toHaveTextContent('7');
    expect(screen.getByTestId('invalid-marker')).toBeInTheDocument();
  });

  it('mirrors the layout for a left-hand home board', () => {
    render(<Board2D model={startingModel('white', { homeSide: 'left' })} theme={theme} />);
    expect(screen.getByTestId('board')).toHaveAttribute('data-home-side', 'left');
    const labels = Array.from(
      screen.getByTestId('point-labels').querySelectorAll('text'),
    ) as SVGTextElement[];
    const bottom = labels
      .filter((t) => Number(t.getAttribute('y')) > 500)
      .sort((a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')))
      .map((t) => t.textContent);
    expect(bottom).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const top = labels
      .filter((t) => Number(t.getAttribute('y')) < 500)
      .sort((a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')))
      .map((t) => t.textContent);
    expect(top).toEqual(['24', '23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13']);
    // Tray on the left of the bar, and the home-board hit areas on the left half.
    const tray = screen.getByTestId('off-white');
    const bar = screen.getByTestId('bar-white');
    expect(Number(tray.getAttribute('x'))).toBeLessThan(Number(bar.getAttribute('x')));
    expect(Number(screen.getByTestId('point-1').getAttribute('x'))).toBeLessThan(750);
    expect(Number(screen.getByTestId('point-24').getAttribute('x'))).toBeLessThan(750);
    expect(Number(screen.getByTestId('point-13').getAttribute('x'))).toBeGreaterThan(750);
    // Black's perspective keeps its own numbering: black's 1-point (abs 24) is bottom-left.
    cleanup();
    render(<Board2D model={startingModel('black', { homeSide: 'left' })} theme={theme} />);
    const p24 = screen.getByTestId('point-24');
    expect(p24).toHaveAttribute('data-rel', '1');
    expect(Number(p24.getAttribute('x'))).toBeLessThan(200);
    expect(Number(p24.getAttribute('y'))).toBe(500);
  });

  it('renders the demo model in both themes without errors', () => {
    for (const id of ['midnight', 'classic']) {
      const { unmount } = render(
        <Board2D
          model={sampleViewModel('black', { kind: 'point', point: 13 })}
          theme={getTheme(id)}
          reducedMotion
        />,
      );
      expect(screen.getByTestId('board')).toBeInTheDocument();
      expect(screen.getByTestId('checkers').querySelectorAll('[data-checker]')).toHaveLength(30);
      unmount();
    }
  });

  it('drags a checker from a source and drops it on the location under the pointer', () => {
    const onDrop = vi.fn();
    const onDragStart = vi.fn();
    render(
      <Board2D
        model={startingModel('white')}
        theme={theme}
        onDrop={onDrop}
        onDragStart={onDragStart}
      />,
    );
    const svg = screen.getByTestId('board') as unknown as SVGSVGElement;
    // Pretend the svg is laid out at 1500x1000 px at the origin so viewBox units == pixels.
    svg.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1500,
      height: 1000,
      right: 1500,
      bottom: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const p8 = screen.getByTestId('point-8');
    fireEvent.pointerDown(p8, { pointerId: 1, button: 0, clientX: 1100, clientY: 900 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 1100, clientY: 880 });
    expect(onDragStart).toHaveBeenCalledWith({ kind: 'point', point: 8 });
    expect(document.querySelector('[data-dragging="true"]')).not.toBeNull();
    expect(screen.getByTestId('board')).toHaveAttribute('data-dragging', 'true');
    // point 5 (white perspective) is bottom row column 7 → x ≈ 734 + 96*1 + 48 = 878
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 878, clientY: 900 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 878, clientY: 900 });
    expect(onDrop).toHaveBeenCalledWith({ kind: 'point', point: 8 }, { kind: 'point', point: 5 });
    expect(document.querySelector('[data-dragging="true"]')).toBeNull();
  });
});
