import type { PieceSet } from './theme';

/** `white` is the lighter checker, `black` the darker one; the engine's colour names are logical. */

export const ivoryEbony: PieceSet = {
  id: 'ivory-ebony',
  name: 'Ivory & Ebony',
  white: { fill: '#f4ecd8', edge: '#b9a57e', sheen: '#ffffff', label: '#3b2f22' },
  black: { fill: '#2a2320', edge: '#0f0c0b', sheen: '#8a766a', label: '#f1e6cf' },
};

export const pearlObsidian: PieceSet = {
  id: 'pearl-obsidian',
  name: 'Pearl & Obsidian',
  white: { fill: '#ece9e2', edge: '#aca596', sheen: '#ffffff', label: '#2a2a2e' },
  black: { fill: '#1c1d24', edge: '#05060a', sheen: '#646a7c', label: '#e9e7e0' },
};

/** Light blue checkers against deep navy. */
export const skyNavy: PieceSet = {
  id: 'sky-navy',
  name: 'Sky & Navy',
  white: { fill: '#9ad4ff', edge: '#3f8fd6', sheen: '#ffffff', label: '#0b2a45' },
  black: { fill: '#0f1c38', edge: '#060d1f', sheen: '#6f8fc9', label: '#e6f0ff' },
};

export const rubyCream: PieceSet = {
  id: 'ruby-cream',
  name: 'Cream & Ruby',
  white: { fill: '#f6ecd9', edge: '#c9b48f', sheen: '#ffffff', label: '#4a2a22' },
  black: { fill: '#c0223a', edge: '#5f0b18', sheen: '#ff9aa8', label: '#fff2f2' },
};

export const jadeCharcoal: PieceSet = {
  id: 'jade-charcoal',
  name: 'Jade & Charcoal',
  white: { fill: '#7fd8b5', edge: '#2f9a72', sheen: '#e9fff6', label: '#0d3326' },
  black: { fill: '#16181b', edge: '#050607', sheen: '#6c747d', label: '#eaf1ee' },
};

export const amberInk: PieceSet = {
  id: 'amber-slate',
  name: 'Amber & Slate',
  white: { fill: '#f2b53c', edge: '#a8701a', sheen: '#fff1c2', label: '#3a2400' },
  black: { fill: '#141a26', edge: '#070a11', sheen: '#7d8ca3', label: '#eef3f8' },
};

export const roseGoldGraphite: PieceSet = {
  id: 'rose-gold-graphite',
  name: 'Rose Gold & Graphite',
  white: { fill: '#e8b4a8', edge: '#b07a6b', sheen: '#fff0ea', label: '#4a221a' },
  black: { fill: '#1a1c20', edge: '#0a0b0d', sheen: '#7f858d', label: '#f0f0f0' },
};

export const PIECE_SETS: PieceSet[] = [
  pearlObsidian,
  ivoryEbony,
  skyNavy,
  rubyCream,
  jadeCharcoal,
  amberInk,
  roseGoldGraphite,
];
