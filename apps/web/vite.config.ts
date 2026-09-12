import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set VITE_BASE_PATH (e.g. "/p2p-gaming/") when deploying under a sub-path such as GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  build: { sourcemap: true, target: 'es2022' },
});
