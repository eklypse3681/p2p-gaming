import { describe, expect, it, vi } from 'vitest';
import { SessionError } from './session';
import type { FlowProgress } from './retry';
import { backoffMs, isRetryable, joinWithRetry, resumeWithRetry, sleepWithAbort } from './retry';

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
const instant = { sleep: vi.fn<Sleep>(async () => {}), now: () => 0 };

function err(code: ConstructorParameters<typeof SessionError>[0]): SessionError {
  return new SessionError(code, code);
}

describe('retry helpers', () => {
  it('backs off 2 s, 4 s, 8 s then 10 s and classifies retryable errors', () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([2000, 4000, 8000, 10_000, 10_000]);
    expect(isRetryable(err('timeout'))).toBe(true);
    expect(isRetryable(err('network'))).toBe(true);
    expect(isRetryable(err('not-found'))).toBe(true);
    expect(isRetryable(err('rejected'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });

  it('sleepWithAbort rejects with cancelled when the signal fires', async () => {
    const ctl = new AbortController();
    const p = sleepWithAbort(10_000, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    const pre = new AbortController();
    pre.abort();
    await expect(sleepWithAbort(1, pre.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('joinWithRetry', () => {
  it('retries timeouts up to the attempt budget and reports progress', async () => {
    const sleep = vi.fn<Sleep>(async () => {});
    const progress: FlowProgress[] = [];
    const join = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(err('timeout'))
      .mockRejectedValueOnce(err('not-found'))
      .mockResolvedValueOnce('session');
    const result = await joinWithRetry(join, 3, { onProgress: (p) => progress.push(p) }, { sleep });
    expect(result).toBe('session');
    expect(join).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
    expect(progress.map((p) => [p.phase, p.attempt, p.nextRetryMs])).toEqual([
      ['joining', 1, undefined],
      ['joining', 1, 2000],
      ['joining', 2, undefined],
      ['joining', 2, 4000],
      ['joining', 3, undefined],
    ]);
  });

  it('gives up after the last attempt and never retries a rejection', async () => {
    const join = vi.fn<() => Promise<string>>().mockRejectedValue(err('timeout'));
    await expect(joinWithRetry(join, 2, {}, instant)).rejects.toMatchObject({ code: 'timeout' });
    expect(join).toHaveBeenCalledTimes(2);
    const rejected = vi.fn<() => Promise<string>>().mockRejectedValue(err('rejected'));
    await expect(joinWithRetry(rejected, 3, {}, instant)).rejects.toMatchObject({
      code: 'rejected',
    });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('stops when aborted during the wait', async () => {
    const ctl = new AbortController();
    const join = vi.fn<() => Promise<string>>().mockRejectedValue(err('timeout'));
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      ctl.abort();
      if (signal?.aborted) throw new SessionError('cancelled', 'Cancelled');
    });
    await expect(joinWithRetry(join, 5, { signal: ctl.signal }, { sleep })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(join).toHaveBeenCalledTimes(1);
  });
});

describe('resumeWithRetry', () => {
  it('re-hosts after a stale address-taken clears (two failures, then success)', async () => {
    const sleep = vi.fn<Sleep>(async () => {});
    const host = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(err('address-taken'))
      .mockRejectedValueOnce(err('address-taken'))
      .mockResolvedValueOnce('host-session');
    const join = vi.fn<() => Promise<string>>();
    const progress: FlowProgress[] = [];
    const result = await resumeWithRetry(
      { hostOnce: host, joinOnce: join, hostName: 'Alice' },
      { onProgress: (p) => progress.push(p) },
      { sleep, now: () => 0 },
    );
    expect(result).toBe('host-session');
    expect(host).toHaveBeenCalledTimes(3);
    expect(join).not.toHaveBeenCalled();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1500, 1500]);
    expect(progress.every((p) => p.phase === 'hosting')).toBe(true);
  });

  it('falls back to joining when the code is really taken', async () => {
    const host = vi.fn<() => Promise<string>>().mockRejectedValue(err('address-taken'));
    const join = vi.fn<() => Promise<string>>().mockResolvedValue('guest-session');
    const result = await resumeWithRetry(
      { hostOnce: host, joinOnce: join, hostName: 'Alice' },
      {},
      instant,
    );
    expect(result).toBe('guest-session');
    expect(host).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(join).toHaveBeenCalledTimes(1);
  });

  it('retries the whole sequence with backoff when joining times out', async () => {
    const sleep = vi.fn<Sleep>(async () => {});
    const host = vi.fn<() => Promise<string>>().mockRejectedValue(err('address-taken'));
    const join = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(err('timeout'))
      .mockRejectedValueOnce(err('timeout'))
      .mockResolvedValueOnce('guest-session');
    const progress: FlowProgress[] = [];
    const result = await resumeWithRetry(
      { hostOnce: host, joinOnce: join, hostName: 'Alice' },
      { onProgress: (p) => progress.push(p) },
      { sleep, now: () => 0 },
    );
    expect(result).toBe('guest-session');
    expect(join).toHaveBeenCalledTimes(3);
    const backoffs = sleep.mock.calls.map((c) => c[0]).filter((ms) => ms !== 1500);
    expect(backoffs).toEqual([2000, 4000]);
    expect(progress.some((p) => p.phase === 'joining' && p.nextRetryMs === 2000)).toBe(true);
  });

  it('a view copy keeps waiting and finally reports host-offline when the budget runs out', async () => {
    let t = 0;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const join = vi.fn<() => Promise<string>>().mockRejectedValue(err('not-found'));
    const progress: FlowProgress[] = [];
    await expect(
      resumeWithRetry(
        { joinOnce: join, hostName: 'Alice' },
        { onProgress: (p) => progress.push(p), maxTotalMs: 5000 },
        { sleep, now: () => t },
      ),
    ).rejects.toMatchObject({ code: 'host-offline' });
    expect(progress.some((p) => p.phase === 'waiting')).toBe(true);
    expect(join.mock.calls.length).toBeGreaterThan(1);
  });

  it('aborting during hosting stops the loop with cancelled', async () => {
    const ctl = new AbortController();
    const host = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      ctl.abort();
      throw new SessionError('cancelled', 'Cancelled');
    });
    const join = vi.fn<() => Promise<string>>();
    await expect(
      resumeWithRetry(
        { hostOnce: host, joinOnce: join, hostName: 'Alice' },
        { signal: ctl.signal },
        instant,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(join).not.toHaveBeenCalled();
  });
});
