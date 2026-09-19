import { SessionError } from './session';

/**
 * Shared retry loop for reopening and joining tables. Signalling can stall (a PeerJS host or join
 * that never completes, a stale registration that frees itself seconds after a reload), so every
 * flow retries with backoff, reports progress, and can be aborted — an aborted flow disposes
 * whatever it created and never hands a session back.
 */

export type FlowPhase = 'hosting' | 'joining' | 'waiting';

export interface FlowProgress {
  phase: FlowPhase;
  /** 1-based overall attempt. */
  attempt: number;
  /** Set while sleeping before the next attempt. */
  nextRetryMs?: number;
  lastError?: string;
}

export interface FlowOptions {
  signal?: AbortSignal;
  onProgress?: (p: FlowProgress) => void;
  /** Give up after this long (default 2 minutes). */
  maxTotalMs?: number;
}

export interface FlowDeps {
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const ADDRESS_TAKEN_RETRIES = 3;
export const ADDRESS_TAKEN_SPACING_MS = 1500;
export const DEFAULT_MAX_TOTAL_MS = 120_000;

export function cancelled(): SessionError {
  return new SessionError('cancelled', 'Cancelled');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** Backoff between whole-sequence retries: 2 s, 4 s, 8 s, then every 10 s. */
export function backoffMs(attempt: number): number {
  return [2000, 4000, 8000][attempt - 1] ?? 10_000;
}

/** Errors worth retrying: the other side may simply not be there yet. */
export function isRetryable(e: unknown): boolean {
  return (
    e instanceof SessionError &&
    (e.code === 'timeout' || e.code === 'network' || e.code === 'not-found')
  );
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Join with up to `attempts` tries. Retries only when the host may just not be there yet
 * (`timeout`, `network`, `not-found`); rejections and cancellations stop immediately.
 */
export async function joinWithRetry<S>(
  joinOnce: () => Promise<S>,
  attempts: number,
  flow: FlowOptions = {},
  deps: FlowDeps = {},
): Promise<S> {
  const sleep = deps.sleep ?? sleepWithAbort;
  let lastError: string | undefined;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(flow.signal);
    flow.onProgress?.({ phase: 'joining', attempt, lastError });
    try {
      return await joinOnce();
    } catch (e) {
      if (e instanceof SessionError && e.code === 'cancelled') throw e;
      if (!isRetryable(e) || attempt >= attempts) throw e;
      lastError = messageOf(e);
      const wait = backoffMs(attempt);
      flow.onProgress?.({ phase: 'joining', attempt, nextRetryMs: wait, lastError });
      await sleep(wait, flow.signal);
    }
  }
}

export interface ResumeSteps<S> {
  /** Host our full copy; absent for a redacted view, which can only rejoin. */
  hostOnce?: () => Promise<S>;
  joinOnce: () => Promise<S>;
  /** For the `host-offline` message. */
  hostName: string;
}

/**
 * Reopen a saved table: host it (retrying a stale `address-taken` a few times before
 * concluding someone else really holds the code), else join; on stalls retry the whole
 * sequence with backoff until the time budget runs out. A view copy keeps trying to join,
 * reporting `waiting`, and finally reports `host-offline`.
 */
export async function resumeWithRetry<S>(
  steps: ResumeSteps<S>,
  flow: FlowOptions = {},
  deps: FlowDeps = {},
): Promise<S> {
  const sleep = deps.sleep ?? sleepWithAbort;
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = flow.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  let lastError: string | undefined;
  let lastErr: unknown;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(flow.signal);
    let taken = false;
    if (steps.hostOnce) {
      let hostErr: unknown;
      for (let t = 0; t <= ADDRESS_TAKEN_RETRIES; t++) {
        throwIfAborted(flow.signal);
        flow.onProgress?.({ phase: 'hosting', attempt, lastError });
        try {
          return await steps.hostOnce();
        } catch (e) {
          if (e instanceof SessionError && e.code === 'cancelled') throw e;
          hostErr = e;
          if (e instanceof SessionError && e.code === 'address-taken') {
            if (t < ADDRESS_TAKEN_RETRIES) await sleep(ADDRESS_TAKEN_SPACING_MS, flow.signal);
            continue;
          }
          break;
        }
      }
      if (hostErr instanceof SessionError && hostErr.code === 'address-taken') {
        taken = true;
      } else if (isRetryable(hostErr)) {
        lastErr = hostErr;
        lastError = messageOf(hostErr);
        if (now() - started >= budget) throw hostErr;
        const wait = backoffMs(attempt);
        flow.onProgress?.({ phase: 'hosting', attempt, nextRetryMs: wait, lastError });
        await sleep(wait, flow.signal);
        continue;
      } else {
        throw hostErr;
      }
    }
    void taken;
    throwIfAborted(flow.signal);
    flow.onProgress?.({ phase: 'joining', attempt, lastError });
    try {
      return await steps.joinOnce();
    } catch (e) {
      if (e instanceof SessionError && e.code === 'cancelled') throw e;
      if (!isRetryable(e)) throw e;
      lastErr = e;
      lastError = messageOf(e);
      const viewOnly = !steps.hostOnce;
      if (now() - started >= budget) {
        if (viewOnly) {
          throw new SessionError(
            'host-offline',
            `Waiting for ${steps.hostName} to reopen the table`,
          );
        }
        throw lastErr;
      }
      const wait = backoffMs(attempt);
      flow.onProgress?.({
        phase: viewOnly ? 'waiting' : 'joining',
        attempt,
        nextRetryMs: wait,
        lastError: viewOnly ? `Waiting for ${steps.hostName} to reopen the table` : lastError,
      });
      await sleep(wait, flow.signal);
    }
  }
}
