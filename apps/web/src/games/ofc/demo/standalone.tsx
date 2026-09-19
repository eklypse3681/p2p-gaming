/**
 * Router-free entry for visual checks of the OFC table (`/src/games/ofc/demo/standalone.html`
 * on the Vite dev server). The app itself mounts `OfcTableDemo` at `#/ofc/demo`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfcTableDemo } from './OfcTableDemo';
import { getTheme, themeToCssVars } from '../../../themes';
import '../../../styles/global.css';

const params = new URLSearchParams(window.location.search);
const theme = getTheme(params.get('theme') ?? 'midnight');
const vars = themeToCssVars(theme);
for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
document.documentElement.dataset.theme = theme.mode;

const variant = (params.get('variant') ?? 'pineapple') as 'ofc' | 'pineapple' | 'pineapple27';
const seats = (Number(params.get('seats') ?? 3) === 2 ? 2 : 3) as 2 | 3;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OfcTableDemo initialVariant={variant} initialSeats={seats} instant={params.has('instant')} />
  </StrictMode>,
);
