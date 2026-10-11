import type {
  PlayerProfile,
  TableClientMessage,
  TableSnapshot,
  Transport,
  TransportProvider,
} from '@bgf/protocol';
import { TransportError, createMemoryPair } from '@bgf/protocol';
import { connLog } from '../session/connLog';
import { sendMail } from './client';
import { seal } from './crypto';
import { withMailboxDevice } from './device';
import type { Envelope } from './envelope';
import { isNewer } from './inbox';

type View = Extract<Envelope, { t: 'view' }>;

/**
 * Playing a table whose host is away. The guest's own app stands in for the host: it greets the
 * table client with the guest's saved view, and every move, readiness or chat the client sends is
 * sealed and mailed to the host's device instead. When the host's device has applied them, the
 * new view comes back by mail (`mailed`) and is handed to the client as the table's state.
 *
 * Nothing is decided here: the stand-in holds no cards and applies no rules. It only carries
 * messages, so the game screen works unchanged.
 */
export class MailRelay {
  private transport: Transport | null = null;
  private snapshot: TableSnapshot;
  private pendingMoves = 0;
  /** The host came back live and this stand-in stepped aside: rejoin the real table. */
  steppedAside = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly slug: string,
    private readonly game: string,
    snapshot: TableSnapshot,
    private readonly seat: number,
  ) {
    this.snapshot = snapshot;
  }

  /** Moves mailed and not yet answered with a new position. */
  get pending(): number {
    return this.pendingMoves;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** A transport provider whose `join` connects to this stand-in. */
  provider(): TransportProvider {
    return {
      name: 'mailbox',
      host: () =>
        Promise.reject(new TransportError('unsupported', 'a mailed table is never hosted')),
      join: async () => {
        const [mine, theirs] = createMemoryPair('mailbox');
        this.attach(mine);
        return theirs;
      },
    };
  }

  private attach(t: Transport): void {
    this.transport = t;
    t.onMessage((raw) => void this.onClient(raw as TableClientMessage));
  }

  private send(msg: unknown): void {
    if (this.transport?.status === 'open') this.transport.send(msg);
  }

  private async onClient(msg: TableClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        this.send({ type: 'welcome', seat: this.seat, snapshot: this.snapshot });
        if (this.snapshot.hostSeat !== null) {
          this.send({ type: 'presence', seat: this.snapshot.hostSeat, connected: false });
        }
        return;
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        return;
      case 'bye':
        this.close();
        return;
      case 'command':
      case 'ready':
      case 'chat':
        await this.mail(msg);
        return;
      default:
        return; // previews and the like mean nothing to an absent host
    }
  }

  /** The host's name, for "Alice is away". */
  get hostName(): string {
    const h = this.snapshot.hostSeat;
    return (h === null ? null : this.snapshot.seats[h]?.name) ?? 'The host';
  }

  private hostKey(): string | undefined {
    const h = this.snapshot.hostSeat;
    return h === null ? undefined : (this.snapshot.seats[h] as PlayerProfile | null)?.publicKey;
  }

  private async mail(msg: TableClientMessage): Promise<void> {
    const key = this.snapshot.options?.mailboxKey;
    const to = this.hostKey();
    try {
      if (typeof key !== 'string' || !to) throw new Error('this table cannot be played by mail');
      const envelope: Envelope = { v: 1, t: 'cmd', game: this.game, seat: this.seat, msg };
      const body = await seal(key, this.snapshot.id, envelope);
      const sent = await withMailboxDevice(this.slug, (device) =>
        sendMail(device.token, { to, match: this.snapshot.id, kind: 'cmd', body, notify: true }),
      );
      if (!sent) throw new Error('the mailbox is not available');
      if (msg.type === 'command') this.pendingMoves++;
      connLog('mailbox: move mailed to the host', { match: this.snapshot.id, type: msg.type });
      this.changed();
    } catch (e) {
      this.send({
        type: 'error',
        code: 'mailbox',
        message: `Could not send that to the host: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /**
   * A position arrived by mail. The client gets it as the table's state (and any problems with
   * our mailed moves as errors). When the host is hosting live right now, this stand-in steps
   * aside: the connection closes and the screen rejoins the real table.
   */
  mailed(e: View): void {
    const incoming = e.snapshot as unknown as TableSnapshot;
    if (incoming.id !== this.snapshot.id) return;
    for (const err of e.errors ?? [])
      this.send({ type: 'error', code: err.code, message: err.message });
    if (isNewer(incoming as never, this.snapshot as never)) {
      this.snapshot = incoming;
      this.pendingMoves = 0;
      this.send({ type: 'state', snapshot: incoming });
    } else if (e.errors?.length) {
      this.pendingMoves = 0;
    }
    this.changed();
    if (e.live) this.stepAside();
  }

  /** The host is reachable again: step aside so the screen rejoins the live table. */
  stepAside(): void {
    if (this.steppedAside) return;
    connLog('mailbox: the host is reachable again; rejoining the live table', {
      match: this.snapshot.id,
    });
    this.steppedAside = true;
    this.close();
  }

  close(): void {
    const t = this.transport;
    this.transport = null;
    t?.close();
  }
}

/** Live relays by match id, so mail collected anywhere in the page reaches the open table. */
export const relays = new Map<string, MailRelay>();
