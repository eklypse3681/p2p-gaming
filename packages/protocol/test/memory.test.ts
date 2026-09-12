import { describe, expect, it } from 'vitest';
import { createMemoryPair, memoryProvider } from '../src/index.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('memory transport', () => {
  it('delivers messages asynchronously in order, cloned', async () => {
    const [a, b] = createMemoryPair();
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    const obj = { x: 1, nested: { y: [1, 2] } };
    a.send(obj);
    a.send('two');
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([obj, 'two']);
    expect(got[0]).not.toBe(obj);
  });

  it('closing one side closes the other', async () => {
    const [a, b] = createMemoryPair();
    const statuses: string[] = [];
    b.onStatus((s) => statuses.push(s));
    a.close();
    expect(a.status).toBe('closed');
    await tick();
    expect(b.status).toBe('closed');
    expect(statuses).toEqual(['closed']);
    expect(() => a.send(1)).toThrow();
  });

  it('provider connects a guest to a hosted code', async () => {
    const p = memoryProvider();
    const listener = await p.host('ABC');
    const incoming: unknown[] = [];
    listener.onConnection((t) => {
      t.onMessage((m) => incoming.push(m));
      t.send({ hi: 'guest' });
    });
    const guest = await p.join('ABC');
    const fromHost: unknown[] = [];
    guest.onMessage((m) => fromHost.push(m));
    guest.send({ hi: 'host' });
    await tick();
    await tick();
    expect(incoming).toEqual([{ hi: 'host' }]);
    expect(fromHost).toEqual([{ hi: 'guest' }]);
    await expect(p.host('ABC')).rejects.toMatchObject({ code: 'address-taken' });
    await expect(p.join('NOPE')).rejects.toMatchObject({ code: 'not-found' });
    listener.close();
    await expect(p.host('ABC')).resolves.toBeTruthy();
  });
});
