import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerProfile, Transport } from '@bgf/protocol';
import { generateKeyPair, signerFor } from '@bgf/protocol';
import { TableClient } from '@bgf/table';

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-dealer-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Poll until `pred` holds (memory transports + WebCrypto handshakes need real time). */
export async function until(pred: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function keyedProfile(id: string, name: string) {
  const keys = await generateKeyPair();
  const profile: PlayerProfile = { id, name, avatar: '🎲', publicKey: keys.publicKey };
  return { profile, signer: signerFor(keys.privateKey) };
}

export async function joinAs(
  transport: Transport,
  id: string,
  name: string,
): Promise<TableClient<unknown, unknown, unknown, unknown>> {
  const { profile, signer } = await keyedProfile(id, name);
  const client = new TableClient<unknown, unknown, unknown, unknown>({
    transport,
    profile,
    signer,
    pingIntervalMs: 0,
  });
  await until(() => client.getState().status !== 'connecting', 5000, `${name} to be answered`);
  return client;
}
