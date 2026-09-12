import type { BoardSet } from './theme';

/** Warm walnut frame, deep green felt, cream and ebony-red points. */
export const walnutGreen: BoardSet = {
  id: 'walnut-green',
  name: 'Walnut & Green',
  frame: '#6b3f22',
  frameEdge: '#3a2010',
  felt: '#1f5a3a',
  pointA: '#e9d9b8',
  pointB: '#7c2f2b',
  pointEdge: 'rgba(0, 0, 0, 0.28)',
  bar: '#5a321b',
  tray: '#4a2916',
  label: '#f1e3c4',
  highlightSource: '#ffd86b',
  highlightTarget: '#8df2b5',
  highlightSelected: '#ffb347',
  diceFace: '#f7f1e3',
  dicePip: '#2b2118',
  cubeFace: '#f1e6cf',
  cubeText: '#2b2118',
};

/** Near-black frame, slate-blue felt, muted gold and graphite points. */
export const midnightSlate: BoardSet = {
  id: 'midnight-slate',
  name: 'Slate & Gold',
  frame: '#1c202b',
  frameEdge: '#080a10',
  felt: '#243349',
  pointA: '#b8913b',
  pointB: '#3b414e',
  pointEdge: 'rgba(0, 0, 0, 0.38)',
  bar: '#141823',
  tray: '#10131b',
  label: '#cbc4ae',
  highlightSource: '#ffd86b',
  highlightTarget: '#6fe3a5',
  highlightSelected: '#ffb347',
  diceFace: '#f2efe6',
  dicePip: '#1b1b1f',
  cubeFace: '#e8ddc1',
  cubeText: '#1f1a10',
};

/** Dark cherry frame, burgundy felt, cream and near-black points. */
export const cherryBurgundy: BoardSet = {
  id: 'cherry-burgundy',
  name: 'Cherry & Burgundy',
  frame: '#5a1f1a',
  frameEdge: '#2e0d0a',
  felt: '#5c1f2b',
  pointA: '#efe0c4',
  pointB: '#1d1416',
  pointEdge: 'rgba(0, 0, 0, 0.35)',
  bar: '#4a1814',
  tray: '#3b1210',
  label: '#f3e4c8',
  highlightSource: '#ffd86b',
  highlightTarget: '#8df2b5',
  highlightSelected: '#ffb347',
  diceFace: '#f7f1e3',
  dicePip: '#2b1a17',
  cubeFace: '#f1e6cf',
  cubeText: '#2b1a17',
};

/** Light oak frame, warm sand felt, terracotta and olive points. */
export const oakSand: BoardSet = {
  id: 'oak-sand',
  name: 'Oak & Sand',
  frame: '#c69a63',
  frameEdge: '#7c5a33',
  felt: '#b9976b',
  pointA: '#b4472a',
  pointB: '#5d6b34',
  pointEdge: 'rgba(0, 0, 0, 0.24)',
  bar: '#a2743f',
  tray: '#8c6236',
  label: '#3a2814',
  highlightSource: '#ffe28a',
  highlightTarget: '#1c7a4f',
  highlightSelected: '#c23f12',
  diceFace: '#fffaf0',
  dicePip: '#2b2118',
  cubeFace: '#fff6e6',
  cubeText: '#2b2118',
};

/** Near-black frame, graphite felt, silver and charcoal points. */
export const carbon: BoardSet = {
  id: 'carbon',
  name: 'Carbon',
  frame: '#15161a',
  frameEdge: '#050506',
  felt: '#33373d',
  pointA: '#b9bec6',
  pointB: '#4a4f58',
  pointEdge: 'rgba(0, 0, 0, 0.4)',
  bar: '#101114',
  tray: '#0c0d0f',
  label: '#c9cdd3',
  highlightSource: '#ffd86b',
  highlightTarget: '#6fe3a5',
  highlightSelected: '#ffb347',
  diceFace: '#f2f2f2',
  dicePip: '#141414',
  cubeFace: '#e6e6e6',
  cubeText: '#141414',
};

/** Teak frame, deep teal felt, ivory and navy points. */
export const marine: BoardSet = {
  id: 'marine',
  name: 'Teak & Teal',
  frame: '#7a4a2a',
  frameEdge: '#3f2412',
  felt: '#0f4c5c',
  pointA: '#efe6d2',
  pointB: '#1b2a4a',
  pointEdge: 'rgba(0, 0, 0, 0.32)',
  bar: '#5c3a22',
  tray: '#4a2e1a',
  label: '#f0e6d0',
  highlightSource: '#ffd86b',
  highlightTarget: '#9af5c8',
  highlightSelected: '#ffb347',
  diceFace: '#f7f4ea',
  dicePip: '#1c1c22',
  cubeFace: '#efe6cf',
  cubeText: '#1c1c22',
};

export const BOARD_SETS: BoardSet[] = [
  midnightSlate,
  walnutGreen,
  marine,
  cherryBurgundy,
  oakSand,
  carbon,
];
