import type { UiPalette } from './theme';

/** A UI look: the app chrome palette plus light/dark mode. */
export interface Look {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  /** The look the app-bar toggle switches to (a light look pairs with a dark one). */
  counterpart: string;
  ui: UiPalette;
}

const font =
  '"Inter", "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const fontMono =
  '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

export const warmLight: Look = {
  id: 'warm-light',
  name: 'Daylight',
  mode: 'light',
  counterpart: 'midnight',
  ui: {
    bg: '#efe6d6',
    surface: '#f9f3e7',
    surfaceRaised: '#fffdf8',
    border: '#d8c8ab',
    text: '#2b2118',
    textMuted: '#7a6a58',
    accent: '#8b4a2b',
    accentText: '#fff8ef',
    danger: '#b23a2f',
    success: '#3f7d4a',
    font,
    fontMono,
  },
};

export const midnightLook: Look = {
  id: 'midnight',
  name: 'Midnight',
  mode: 'dark',
  counterpart: 'warm-light',
  ui: {
    bg: '#0d0f15',
    surface: '#151924',
    surfaceRaised: '#1d2330',
    border: '#2a3242',
    text: '#e9e7e0',
    textMuted: '#9aa1ae',
    accent: '#d4a942',
    accentText: '#17130a',
    danger: '#e0574c',
    success: '#5fc08b',
    font,
    fontMono,
  },
};

export const slate: Look = {
  id: 'slate',
  name: 'Slate',
  mode: 'dark',
  counterpart: 'paper',
  ui: {
    bg: '#0f141b',
    surface: '#171e27',
    surfaceRaised: '#1f2833',
    border: '#2c3846',
    text: '#e6ebf0',
    textMuted: '#97a4b3',
    accent: '#5cc8ff',
    accentText: '#06202e',
    danger: '#ff6b62',
    success: '#4fd39a',
    font,
    fontMono,
  },
};

export const paper: Look = {
  id: 'paper',
  name: 'Paper',
  mode: 'light',
  counterpart: 'slate',
  ui: {
    bg: '#ffffff',
    surface: '#f6f6f4',
    surfaceRaised: '#ffffff',
    border: '#cfd3d8',
    text: '#111418',
    textMuted: '#4d5561',
    accent: '#1f5fbf',
    accentText: '#ffffff',
    danger: '#b3261e',
    success: '#1d7a45',
    font,
    fontMono,
  },
};

export const LOOKS: Look[] = [midnightLook, warmLight, slate, paper];
