import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setRevocationLookup } from '@bgf/table';
import { App } from './app/App';
import { lookupRevocation } from './session/revocations';
import './styles/global.css';

// Tables and clubs hosted in this browser check a player's signed-out devices before seating one.
setRevocationLookup((playerKey) => lookupRevocation(playerKey));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
