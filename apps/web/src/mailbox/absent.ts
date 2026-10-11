import type { PlayerProfile } from '@bgf/protocol';
import { connLog } from '../session/connLog';
import { sendMail } from './client';
import { seal } from './crypto';
import { ensureMailboxDevice } from './device';
import type { Envelope } from './envelope';

/** What the host's mailer needs to know about the table it hosts. */
export interface HostedTable {
  game: string;
  matchId(): string;
  /** The match's mailbox key; nothing is mailed without one. */
  key(): string | undefined;
  seq(): number;
  /** Seated players by seat index. */
  seats(): (PlayerProfile | null)[];
  /** Seats with a device connected right now. */
  connected(): number[];
  /** The position as `seat` may see it. */
  viewFor(seat: number): Extract<Envelope, { t: 'view' }>['snapshot'];
  /** Whether `seat` has something to do (worth a notification). */
  yourTurn(seat: number): boolean;
  onChange(listener: () => void): () => void;
}

export interface AbsentMailerOptions {
  /** How long a seat must have been gone before it is mailed (a blip reconnects first). */
  graceMs?: number;
  /** Changes within this window are mailed as one. */
  debounceMs?: number;
  /** How often presence is re-checked (presence changes are not announced). */
  pollMs?: number;
}

/**
 * While this device hosts a table, mail the position to every seated player who is away,
 * whenever it changes, waking them when it is their turn. The mailbox keeps only the latest
 * uncollected position, so a burst of changes costs one message to collect.
 */
export function mailAbsentSeats(
  slug: string,
  table: HostedTable,
  me: number | null,
  opts: AbsentMailerOptions = {},
): () => void {
  const grace = opts.graceMs ?? 15_000;
  const debounce = opts.debounceMs ?? 1500;
  const absentSince = new Map<number, number>();
  /** Seats seen connected while hosting: only they get the grace period (they may be back). */
  const seen = new Set<number>();
  const sentSeq = new Map<number, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  const check = async (final = false) => {
    timer = null;
    if ((stopped && !final) || running) return;
    const key = table.key();
    if (!key) return;
    running = true;
    try {
      const now = Date.now();
      const connected = new Set(table.connected());
      const seq = table.seq();
      let wait = Infinity;
      for (const [seat, p] of table.seats().entries()) {
        if (seat === me || !p?.publicKey) continue;
        if (connected.has(seat)) {
          seen.add(seat);
          absentSince.delete(seat);
          sentSeq.delete(seat);
          continue;
        }
        const since = absentSince.get(seat) ?? now;
        absentSince.set(seat, since);
        if (!final && seen.has(seat) && now - since < grace) {
          wait = Math.min(wait, grace - (now - since));
          continue;
        }
        if (sentSeq.get(seat) === seq) continue;
        const device = await ensureMailboxDevice(slug);
        if (!device || (stopped && !final)) return;
        const envelope: Envelope = {
          v: 1,
          t: 'view',
          game: table.game,
          snapshot: table.viewFor(seat),
          live: true,
        };
        const notify = table.yourTurn(seat);
        await sendMail(device.token, {
          to: p.publicKey,
          match: table.matchId(),
          kind: 'view',
          body: await seal(key, table.matchId(), envelope),
          notify,
        });
        sentSeq.set(seat, seq);
        connLog('mailbox: position mailed', { seat, seq, notify });
      }
      if (wait !== Infinity) schedule(wait + 50);
    } catch (e) {
      connLog('mailbox: could not mail the position', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void check(), ms);
  };
  const unsub = table.onChange(() => schedule(debounce));
  const poll = setInterval(() => {
    if (timer === null) void check();
  }, opts.pollMs ?? 5000);
  schedule(debounce);
  return () => {
    if (stopped) return;
    stopped = true;
    unsub();
    clearInterval(poll);
    if (timer !== null) clearTimeout(timer);
    // Leaving (closing the game, the page going away): mail what has not been mailed yet.
    void check(true);
  };
}
