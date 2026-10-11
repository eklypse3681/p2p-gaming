import type { TableClientMessage, TableSnapshot } from '@bgf/protocol';
import type { EntropySource } from '@bgf/table';
import type { Runtime } from '../session/runtimes';

export interface MailedCommand {
  seat: number;
  msg: TableClientMessage;
  /** The mailbox sender: the player's root key, which must be the seat's. */
  from: string;
}

export interface Applied {
  snapshot: TableSnapshot;
  /** What the table told each seat about its mailed moves (only seats with problems). */
  errors: Map<number, { code: string; message: string }[]>;
}

/**
 * Apply moves mailed to this device, the host, for a table nobody has open: restore the table
 * from its saved copy with the runtime it is pinned to, hand it each move as if that seat had
 * sent it, let the autopilot do what it would have (deal the next hand), and put it away again
 * without revealing anything. Used by a page that is not showing the table and by the service
 * worker woken by a push.
 */
export async function applyMailed(
  rt: Runtime,
  snapshot: TableSnapshot,
  commands: MailedCommand[],
  opts: { entropy?: EntropySource } = {},
): Promise<Applied> {
  const def = (
    rt.definitions as Record<string, Parameters<Runtime['TableServer']['create']>[0]['def']>
  )[snapshot.gameId];
  if (!def) throw new Error(`no rules for ${snapshot.gameId}`);
  const hostProfile =
    snapshot.hostSeat !== null ? snapshot.seats[snapshot.hostSeat] : snapshot.dealer;
  if (!hostProfile) throw new Error('the table has no host');
  const randomness = snapshot.options?.randomness as { mode?: string } | undefined;
  const server = await rt.TableServer.create({
    def,
    snapshot,
    code: snapshot.code,
    host: hostProfile,
    ...(opts.entropy && randomness?.mode
      ? { entropy: { source: opts.entropy, fallback: false } }
      : {}),
  });
  const errors = new Map<number, { code: string; message: string }[]>();
  try {
    for (const c of commands) {
      const seated = snapshot.seats[c.seat];
      if (!seated?.publicKey || seated.publicKey !== c.from) {
        errors.set(c.seat, [
          ...(errors.get(c.seat) ?? []),
          { code: 'not-your-seat', message: 'that move came from someone else' },
        ]);
        continue;
      }
      const out = await server.deliver(c.seat, c.msg);
      if (out.errors.length) errors.set(c.seat, [...(errors.get(c.seat) ?? []), ...out.errors]);
    }
    await server.settle();
    return { snapshot: server.getSnapshot(), errors };
  } finally {
    server.close({ suspend: true });
  }
}
