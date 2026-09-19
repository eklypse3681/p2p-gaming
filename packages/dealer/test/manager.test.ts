import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryProvider } from '@bgf/protocol';
import type { ManagerEvent } from '../src/index.js';
import { DealerManager, ManagerError, describeConfig, presetsFor } from '../src/index.js';
import { joinAs, tempDir, until } from './helpers.js';

describe('DealerManager', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('creates, lists, reports status, stops, resumes and removes tables', async () => {
    const provider = memoryProvider();
    const manager = await DealerManager.open({ dataDir: dir, transportFor: () => provider });
    const events: ManagerEvent[] = [];
    manager.subscribe((e) => events.push(e));

    const preset = presetsFor('ofc').find((p) => p.id === 'standard-pineapple')!;
    const created = await manager.create({
      game: 'ofc',
      config: { ...(preset.config as object), seats: 3 },
      name: 'Friday night',
      code: 'MGR001',
    });
    expect(created.status).toBe('running');
    expect(created.game).toBe('ofc');
    expect(created.code).toBe('MGR001');
    expect(created.seatsInfo).toHaveLength(3);
    expect(created.occupied).toBe(0);
    expect(created.rules).toContain('Pineapple');
    expect(created.randomness).toEqual({ mode: 'per-draw', provider: 'crypto' });
    expect(created.dealer?.name).toBe('Dealer');
    expect(created.inviteLink).toContain('#/ofc/join/MGR001');
    expect(events.some((e) => e.type === 'created')).toBe(true);

    // A guest joins: the seat shows up and an event is emitted.
    const guest = await joinAs(await provider.join('MGR001'), 'g1', 'Bob');
    expect(guest.getState().seat).toBe(0);
    await until(() => events.some((e) => e.type === 'seat'), 3000, 'seat event');
    const info = await manager.info(created.id);
    expect(info.seatsInfo[0]).toMatchObject({ seat: 0, name: 'Bob', connected: true, devices: 1 });
    expect(info.occupied).toBe(1);

    // Public snapshot never carries the deck.
    const pub = await manager.publicSnapshot(created.id);
    expect(pub?.view).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('"deck"');

    const list = await manager.list();
    expect(list.map((t) => t.id)).toEqual([created.id]);

    guest.close();
    const stopped = await manager.stop(created.id);
    expect(stopped.status).toBe('stopped');
    await expect(manager.stop(created.id)).rejects.toBeInstanceOf(ManagerError);

    // A fresh manager sees the table as stopped and can resume it under the same id.
    const again = await DealerManager.open({ dataDir: dir, transportFor: () => memoryProvider() });
    const listed = await again.list();
    expect(listed[0]).toMatchObject({ id: created.id, status: 'stopped', name: 'Friday night' });
    const resumed = await again.resume('MGR001');
    expect(resumed).toMatchObject({ id: created.id, status: 'running' });
    await expect(again.remove(created.id)).rejects.toMatchObject({ code: 'running' });
    await again.stop(created.id);
    await again.remove(created.id, { purge: true });
    expect(await again.list()).toEqual([]);
    await expect(again.resume('MGR001')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('runs an OFC hand through dealer commands and exposes the ledger', async () => {
    const provider = memoryProvider();
    const manager = await DealerManager.open({ dataDir: dir, transportFor: () => provider });
    const created = await manager.create({
      game: 'ofc',
      config: {
        variant: 'pineapple',
        seats: 2,
        scoring: { mode: 'buyin', buyIn: 100, multiplier: 0.5 },
      },
      code: 'MGR002',
    });
    const a = await joinAs(await provider.join('MGR002'), 'a', 'Ada');
    const b = await joinAs(await provider.join('MGR002'), 'b', 'Grace');
    expect([a.getState().seat, b.getState().seat].sort()).toEqual([0, 1]);

    // The table is unattended: the hand dealt itself once both seats were taken, and a manual
    // "start" on top of it is refused.
    await until(() => (a.getState().snapshot?.seq ?? 0) >= 1, 3000, 'guest state');
    const state = a.getState().snapshot!.state as { hand: { phase: string } | null };
    expect(state.hand?.phase).toBe('setting');
    expect((await manager.info(created.id)).autopilot).toMatchObject({ enabled: true });
    await expect(manager.sendDealerCommand(created.id, { type: 'start' })).rejects.toMatchObject({
      code: 'refused',
    });

    const ledger = await manager.ledger(created.id);
    expect(ledger).toMatchObject({
      mode: 'buyin',
      buyIn: 100,
      multiplier: 0.5,
      balances: [100, 100],
    });
    expect(ledger?.names).toEqual(['Ada', 'Grace']);
    expect(await manager.ledger('nope')).toBeNull();

    const audit = await manager.audit(created.id);
    expect(audit?.options.randomness).toMatchObject({ provider: 'crypto' });
    a.close();
    b.close();
    await manager.close();
  });

  it('validates creation input and settings', async () => {
    const manager = await DealerManager.open({
      dataDir: dir,
      transportFor: () => memoryProvider(),
    });
    await expect(manager.create({ game: 'ofc', config: { seats: 5 } })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      manager.create({ game: 'ofc', randomness: 'beacon', entropy: 'crypto' }),
    ).rejects.toThrow(/drand/);
    await expect(manager.create({ game: 'ofc', entropy: 'random.org' })).rejects.toThrow(/API key/);
    await manager.close();

    const s = await manager.updateSettings({
      dealerName: 'House',
      randomOrgApiKey: 'abc12345',
      defaultRandomness: 'seeded',
      appUrl: 'http://localhost:5173',
      // unknown / malformed values are ignored
      defaultEntropy: 'nope' as never,
    });
    expect(s).toMatchObject({
      dealerName: 'House',
      randomOrgApiKey: 'abc12345',
      defaultRandomness: 'seeded',
      appUrl: 'http://localhost:5173/',
      defaultEntropy: 'crypto',
    });
    // A masked key coming back from the console keeps the real one.
    const kept = await manager.updateSettings({ randomOrgApiKey: '••••2345' });
    expect(kept.randomOrgApiKey).toBe('abc12345');
    const reopened = await DealerManager.open({
      dataDir: dir,
      transportFor: () => memoryProvider(),
    });
    expect(reopened.settings().dealerName).toBe('House');

    // Seeded tables draw a committed seed per hand from the default source.
    const t = await reopened.create({ game: 'backgammon', config: { length: 1 }, name: 'seeded' });
    expect(t.randomness).toEqual({ mode: 'seeded', provider: 'crypto' });
    expect(t.dealer?.name).toBe('House');
    expect(t.rules).toBe('1-point match · Crawford');
    await reopened.close();
  });

  it('stores named rule sets and describes configs', async () => {
    const manager = await DealerManager.open({
      dataDir: dir,
      transportFor: () => memoryProvider(),
    });
    expect(await manager.listRulesets()).toEqual([]);
    const saved = await manager.saveRuleset('Our 2-7', { variant: 'pineapple27', seats: 3 });
    expect(saved.name).toBe('Our 2-7');
    expect(saved.config.variant).toBe('pineapple27');
    await expect(manager.saveRuleset('bad', { variant: 'nope' })).rejects.toMatchObject({
      code: 'invalid',
    });
    const list = await manager.listRulesets();
    expect(list.map((r) => r.name)).toEqual(['Our 2-7']);
    expect(list[0]!.description).toContain('Pineapple 2-7');
    await manager.deleteRuleset('Our 2-7');
    expect(await manager.listRulesets()).toEqual([]);

    expect(describeConfig('backgammon', { length: 0, jacoby: true })).toBe(
      'Money session · Jacoby',
    );
    expect(describeConfig('backgammon', { length: 5, crawford: true, rules: 'free' })).toBe(
      '5-point match · Crawford · free board',
    );
    expect(presetsFor('backgammon').map((p) => p.id)).toContain('money');
  });
});
