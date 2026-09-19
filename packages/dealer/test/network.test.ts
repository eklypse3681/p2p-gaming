import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { peerJsProvider } from '@bgf/transport-peerjs';
import { main } from '../src/index.js';
import { joinAs, tempDir, until } from './helpers.js';

/**
 * Real network: runs the CLI binary as a child process hosting backgammon on the free PeerJS
 * cloud, joins it from this process over WebRTC, then stops it with `dealer stop`.
 *
 *   E2E_NETWORK=1 pnpm vitest run --project dealer -t "CLI over the real cloud"
 */
describe.skipIf(!process.env.E2E_NETWORK)('dealer CLI over the real cloud', () => {
  it(
    'hosts from a child process, seats a Node guest, and stops on request',
    {
      timeout: 90_000,
    },
    async () => {
      const { dir, cleanup } = await tempDir();
      const bin = join(import.meta.dirname, '..', 'bin', 'dealer.mjs');
      const code = `CLI${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const child = spawn(
        process.execPath,
        [bin, 'host', '--game', 'backgammon', '--code', code, '--data', dir, '--name', 'House'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      try {
        await until(() => out.includes(`Room code:    ${code}`), 45_000, 'the CLI to host');
        expect(out).toContain(`#/backgammon/join/${code}`);

        const provider = peerJsProvider({ namespace: 'backgammon-v1' });
        const transport = await provider.join(code, { timeoutMs: 30_000 });
        const guest = await joinAs(transport, 'net-guest', 'Bob');
        expect(guest.getState().status).toBe('joined');
        expect(guest.getState().seat).toBe(0);
        expect(guest.getState().snapshot?.dealer?.name).toBe('House');
        guest.send({ type: 'start-game' });
        await until(() => (guest.getState().snapshot?.seq ?? 0) >= 1, 10_000, 'start-game');
        guest.close();

        const lines: string[] = [];
        expect(
          await main(['stop', code, '--data', dir], {
            log: (l) => lines.push(l),
            error: (l) => lines.push(l),
          }),
        ).toBe(0);
        expect(await exited).toBe(0);
        expect(out).toContain('stopping');
        expect(
          await main(['status', code, '--data', dir], {
            log: (l) => lines.push(l),
            error: (l) => lines.push(l),
          }),
        ).toBe(0);
        expect(lines.join('\n')).toContain('seq 1');
      } finally {
        if (child.exitCode === null) child.kill('SIGINT');
        await cleanup();
      }
    },
  );
});
