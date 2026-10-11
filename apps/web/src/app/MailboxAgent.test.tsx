import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithProfile } from '../test/renderWithProfile';
import { createProfile, resetProfilesForTests } from '../session/profiles';

const checks = vi.fn(async () => []);
vi.mock('../mailbox/device', () => ({
  withMailboxDevice: async (_slug: string, fn: (d: unknown) => Promise<unknown>) =>
    fn({ slug: 'alice', player: 'p', token: 't', registeredAt: 0 }),
}));
vi.mock('../mailbox/inbox', () => ({ processInbox: () => checks() }));

import { CHECK_MAIL_EVENT, MAIL_MESSAGE, MailboxAgent } from './MailboxAgent';

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('MailboxAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checks.mockClear();
    localStorage.clear();
    resetProfilesForTests();
    createProfile('Alice');
  });
  afterEach(() => vi.useRealTimers());

  it('checks on opening and every 5 s for 30 s, then never on its own', async () => {
    renderWithProfile('alice', <MailboxAgent />);
    await advance(0);
    expect(checks).toHaveBeenCalledTimes(1);
    await advance(30_000);
    // 5, 10, 15, 20, 25, 30 s.
    expect(checks).toHaveBeenCalledTimes(7);
    await advance(60 * 60_000);
    expect(checks).toHaveBeenCalledTimes(7);
  });

  it('a table that goes on by mail starts another 30 s of checks', async () => {
    renderWithProfile('alice', <MailboxAgent />);
    await advance(120_000);
    const before = checks.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(CHECK_MAIL_EVENT));
    });
    await advance(10 * 60_000);
    expect(checks.mock.calls.length - before).toBe(7);
  });

  it('a push collects at once', async () => {
    const listeners: ((e: MessageEvent) => void)[] = [];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.push(l),
        removeEventListener: () => {},
      },
    });
    renderWithProfile('alice', <MailboxAgent />);
    await advance(120_000);
    const before = checks.mock.calls.length;
    await act(async () => {
      listeners.forEach((l) => l(new MessageEvent('message', { data: { type: MAIL_MESSAGE } })));
    });
    await advance(0);
    expect(checks.mock.calls.length - before).toBe(1);
  });
});
