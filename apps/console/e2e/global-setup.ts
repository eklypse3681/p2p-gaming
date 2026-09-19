import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Starts a real `dealer serve` over the in-memory transport (no PeerJS, no network) on a fixed
 * port, waits for `/api/status`, and tears it down after the run.
 */
const PORT = 7791;
let child: ChildProcess | null = null;
let dir = '';

export default async function globalSetup(): Promise<() => Promise<void>> {
  dir = await mkdtemp(join(tmpdir(), 'console-e2e-'));
  const bin = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'packages',
    'dealer',
    'bin',
    'dealer.mjs',
  );
  child = spawn(process.execPath, [bin, 'serve', '--port', String(PORT), '--data', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, P2P_DEALER_TRANSPORT: 'memory' },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`dealer serve did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return async () => {
    child?.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    child?.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  };
}
