import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The build lands inside the dealer package so `dealer serve` can serve it without a bundler.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': { target: 'http://127.0.0.1:7777', changeOrigin: false } },
  },
  build: {
    outDir: '../../packages/dealer/console',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
