import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build's version: the commit it was built from (CI sets GITHUB_SHA), else the local HEAD,
 * else the build time. Baked into the app and published as `version.json`, so an open page can
 * tell when the site has moved on and offer a reload.
 */
function buildVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now()}`;
  }
}
const VERSION = buildVersion();

function versionFile(): Plugin {
  return {
    name: 'version-file',
    apply: 'build',
    async writeBundle(options) {
      await writeFile(join(options.dir!, 'version.json'), JSON.stringify({ version: VERSION }));
    },
  };
}

// Set VITE_BASE_PATH (e.g. "/p2p-gaming/") when deploying under a sub-path such as GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), versionFile()],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  server: { port: 5173, strictPort: false },
  build: { sourcemap: true, target: 'es2022' },
});
