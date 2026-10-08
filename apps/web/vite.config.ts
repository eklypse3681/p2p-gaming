import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Publishes the table runtime (`src/runtime.ts`) next to the app: `runtime/manifest.json` names
 * the entry file and every file it imports, each with its SHA-256, plus a `version` that hashes
 * them all. A club's dealer fetches that set, checks the hashes and imports the entry, so it runs
 * exactly the code the app runs. The files are the app's own chunks: nothing is built twice.
 */
function runtimeManifest(): Plugin {
  return {
    name: 'runtime-manifest',
    apply: 'build',
    // After writing, so the hashes cover the files exactly as served (source-map comment included).
    async writeBundle(options, bundle) {
      const outDir = options.dir!;
      const entry = Object.values(bundle).find(
        (f) => f.type === 'chunk' && f.isEntry && f.name === 'runtime',
      );
      if (!entry || entry.type !== 'chunk') this.error('runtime entry missing from the build');
      const files: { path: string; sha256: string }[] = [];
      const seen = new Set<string>();
      const visit = async (fileName: string) => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const out = bundle[fileName];
        if (!out || out.type !== 'chunk') return;
        const code = await readFile(join(outDir, fileName));
        files.push({ path: fileName, sha256: createHash('sha256').update(code).digest('hex') });
        for (const dep of [...out.imports, ...out.dynamicImports]) await visit(dep);
      };
      await visit(entry.fileName);
      const version = createHash('sha256')
        .update(files.map((f) => `${f.path}:${f.sha256}`).join('\n'))
        .digest('hex')
        .slice(0, 16);
      await mkdir(join(outDir, 'runtime'), { recursive: true });
      await writeFile(
        join(outDir, 'runtime/manifest.json'),
        JSON.stringify({ format: 1, version, entry: entry.fileName, files }, null, 2),
      );
    },
  };
}

// Set VITE_BASE_PATH (e.g. "/p2p-gaming/") when deploying under a sub-path such as GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), runtimeManifest()],
  server: { port: 5173, strictPort: false },
  build: {
    sourcemap: true,
    target: 'es2022',
    manifest: true,
    rollupOptions: {
      input: { main: 'index.html', runtime: 'src/runtime.ts' },
      // App builds normally drop an entry's exports; the runtime's exports are its whole point.
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'runtime' ? 'runtime/runtime-[hash].js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
