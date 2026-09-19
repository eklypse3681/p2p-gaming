import { describe, expect, it } from 'vitest';
import { generateKeyPair, signerFor } from '@bgf/protocol';
import type { ConformanceMember, ConformanceTarget } from '../src/conformance/index.js';
import {
  MemoryClub,
  formatConformanceReport,
  runClubConformance,
  runClubConformanceChecks,
} from '../src/conformance/index.js';

const cache = new Map<string, Promise<{ publicKey: string; privateKey: string }>>();
function keysFor(name: string) {
  let p = cache.get(name);
  if (!p) {
    p = generateKeyPair();
    cache.set(name, p);
  }
  return p;
}

async function member(name: string): Promise<ConformanceMember> {
  const keys = await keysFor(name);
  return {
    profile: { id: `id-${name}`, name, publicKey: keys.publicKey },
    signer: signerFor(keys.privateKey),
  };
}

async function create(): Promise<ConformanceTarget> {
  const club = await MemoryClub.create();
  const members = await Promise.all([member('ada'), member('bob'), member('cy')]);
  return {
    club,
    members,
    strangers: [await member('mallory')],
    templateId: club.templateId,
    fund: (id, amount) => club.fund(id, amount),
    ban: (id) => club.ban(id),
    advance: async (ms) => club.advance(ms),
    close: async () => {},
  };
}

describe('MemoryClub', () => runClubConformance({ name: 'MemoryClub', create }));

describe('the headless runner', () => {
  it('reports every check and formats a readable summary', async () => {
    const report = await runClubConformanceChecks({ name: 'MemoryClub', create });
    expect(report.results.length).toBeGreaterThan(20);
    expect(report.failed, formatConformanceReport(report)).toBe(0);
    expect(report.ok).toBe(true);
    expect(formatConformanceReport(report)).toContain('conformant');
  }, 60_000);
});
