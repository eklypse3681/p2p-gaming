import type {
  ChipRequest,
  ClubCurrency,
  ClubInvite,
  ClubMember,
  LedgerEntry,
  LedgerKind,
  LobbyTable,
  MemberRole,
  MemberStatement,
  Room,
  TableTemplate,
} from '@bgf/protocol';
import type { GamePreset } from '../api/client';
import { API_BASE } from '../api/client';

// ---- types mirrored from the platform runtime (its host and store) so the browser bundle never
// ---- imports the Node package.

export interface ClubSummary {
  id: string;
  name: string;
  tagline?: string;
  currency: ClubCurrency;
  publicKey: string;
  ownerId: string;
  status: 'active' | 'suspended';
  createdAt: number;
  members: number;
  pendingMembers: number;
  online: number;
  reserve: number;
  circulation: number;
  minted: number;
  burned: number;
  tables: number;
  rooms: number;
}

/** One member waiting to be matched. */
export interface QueuedTicket {
  id: string;
  memberId: string;
  game: string;
  queuedAt: number;
  waitMs: number;
}

/** What the club's matchmaker is doing right now. */
export interface MatchmakingStatus {
  running: boolean;
  queued: number;
  depthByGame: Record<string, number>;
  medianWaitMs: number;
  matchesPerMinute: number;
  matchesTotal: number;
  expiredTotal: number;
  cancelledTotal: number;
  oldestWaitMs: number;
  /** True for the public play-money club. */
  house: boolean;
  tickets: QueuedTicket[];
  /** Only on pause/resume/drain. */
  drained?: number;
}

/** Ratings per game, per member. */
export type RatingBook = Record<string, Record<string, number>>;

export type PurchaseMethod = 'dev' | 'manual';
export type PurchaseStatus = 'pending' | 'paid' | 'cancelled';

export interface PurchaseRow {
  id: string;
  clubId: string;
  amount: number;
  priceCents: number | null;
  method: PurchaseMethod;
  reference: string | null;
  status: PurchaseStatus;
  certificate: string | null;
  requestedBy: string | null;
  createdAt: number;
  paidAt: number | null;
}

export type ClubRole = MemberRole | 'operator';

export interface InviteRow {
  nonce: string;
  role: MemberRole;
  autoApprove: boolean;
  expiresAt?: number;
  maxUses?: number;
  uses: number;
}

/** Members see a trimmed roster (no keys, active members only); admins get full rows. */
export type MemberRow = Pick<ClubMember, 'id' | 'name' | 'role' | 'status' | 'joinedAt'> &
  Partial<Pick<ClubMember, 'avatar' | 'publicKey'>>;

export interface ClubDetail extends Omit<ClubSummary, 'members' | 'online' | 'tables' | 'rooms'> {
  role: ClubRole | null;
  rooms: Room[];
  tables: LobbyTable[];
  members: MemberRow[];
  requests: ChipRequest[];
  invites: InviteRow[];
  online: string[];
  purchases: PurchaseRow[];
  games: string[];
  minRakeBps: number;
}

export interface Me {
  profileId: string;
  name: string;
  publicKey: string;
  operator: boolean;
  clubs: Array<ClubSummary & { role: ClubRole }>;
}

export interface LoginResponse {
  token: string;
  profileId: string;
  name: string;
  expiresAt: number;
  operator: boolean;
}

/** One row of the platform event feed (`EventRow` on the server; `data` when already parsed). */
export interface PlatformEvent {
  id?: string;
  seq: number;
  clubId: string | null;
  at: number;
  type: string;
  message: string;
  data?: unknown;
  dataJson?: string | null;
}

export interface LedgerPage {
  total: number;
  entries: LedgerEntry[];
}

export interface LedgerVerification {
  ok: boolean;
  entries: number;
  problem?: { seq: number; reason: string };
  totals?: { minted: number; burned: number; reserve: number; circulation: number };
}

export interface HistoryRecord {
  at: number;
  kind: 'ledger' | 'hand' | 'game' | 'purchase' | 'sit' | 'leave' | 'settle' | 'note' | string;
  tableId?: string;
  memberIds?: string[];
  seq?: number;
  data: unknown;
}

export interface InviteResult {
  token: string;
  invite: ClubInvite;
  link: string;
}

export interface OperatorClub extends ClubSummary {
  sales: number;
  pendingPurchases: number;
}

export interface OperatorReport {
  at: number;
  clubs: Array<ClubSummary & { purchases: number }>;
}

export type TemplateInput = Omit<TableTemplate, 'id'>;

export const LEDGER_KINDS: LedgerKind[] = [
  'mint',
  'burn',
  'grant',
  'redeem',
  'buy-in',
  'cash-out',
  'result',
  'transfer',
  'fee',
  'adjust',
];

// ---- session token -----------------------------------------------------------------------------

export const PLATFORM_TOKEN_KEY = 'platform-session-token';

export function getPlatformToken(): string {
  try {
    return localStorage.getItem(PLATFORM_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setPlatformToken(token: string): void {
  try {
    if (token) localStorage.setItem(PLATFORM_TOKEN_KEY, token);
    else localStorage.removeItem(PLATFORM_TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

/** Separate from the dealer's `ApiError` so `useResource` never raises the dealer token gate. */
export class PlatformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body) headers['content-type'] = 'application/json';
  const token = getPlatformToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    // A rejected session sends the console back to the login page; a failed login does not.
    if (res.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('platform:unauthorized'));
    throw new PlatformApiError(res.status, b.error ?? 'error', b.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });
const enc = encodeURIComponent;
const clubPath = (clubId: string, sub = '') => `/clubs/${enc(clubId)}${sub}`;

export const platformApi = {
  challenge: (body: { profileId: string; publicKey: string }) =>
    post<{ nonce: string }>('/auth/challenge', body),
  login: (body: { profileId: string; publicKey: string; name: string; signature: string }) =>
    post<LoginResponse>('/auth/login', body),
  logout: () => post<{ ok: true }>('/auth/logout'),
  me: () => request<Me>('/me'),
  presets: (game: string) => request<GamePreset[]>(`/presets?game=${enc(game)}`),

  createClub: (body: { name: string; currency: Partial<ClubCurrency>; tagline?: string }) =>
    post<ClubSummary>('/clubs', body),
  club: (clubId: string) => request<ClubDetail>(clubPath(clubId)),
  purchase: (
    clubId: string,
    body: { amount: number; method: PurchaseMethod; reference?: string },
  ) => post<PurchaseRow>(clubPath(clubId, '/purchase'), body),

  approve: (clubId: string, memberId: string) =>
    post<ClubDetail>(clubPath(clubId, `/members/${enc(memberId)}/approve`)),
  ban: (clubId: string, memberId: string) =>
    post<ClubDetail>(clubPath(clubId, `/members/${enc(memberId)}/ban`)),
  setRole: (clubId: string, memberId: string, role: MemberRole) =>
    post<ClubDetail>(clubPath(clubId, `/members/${enc(memberId)}/role`), { role }),
  grant: (clubId: string, memberId: string, body: { amount: number; note?: string }) =>
    post<ClubDetail>(clubPath(clubId, `/members/${enc(memberId)}/grant`), body),
  redeem: (clubId: string, memberId: string, body: { amount: number; note?: string }) =>
    post<ClubDetail>(clubPath(clubId, `/members/${enc(memberId)}/redeem`), body),
  resolveRequest: (
    clubId: string,
    requestId: string,
    body: { decision: 'granted' | 'declined'; note?: string },
  ) => post<ChipRequest>(clubPath(clubId, `/requests/${enc(requestId)}`), body),

  createInvite: (
    clubId: string,
    body: { role: MemberRole; autoApprove: boolean; maxUses?: number; expiresAt?: number },
  ) => post<InviteResult>(clubPath(clubId, '/invites'), body),
  revokeInvite: (clubId: string, nonce: string) =>
    del<{ ok: true }>(clubPath(clubId, `/invites/${enc(nonce)}`)),

  matchmaking: (clubId: string) => request<MatchmakingStatus>(clubPath(clubId, '/matchmaking')),
  matchmakingControl: (clubId: string, action: 'pause' | 'resume' | 'drain') =>
    post<MatchmakingStatus>(clubPath(clubId, `/matchmaking/${action}`)),
  ratings: (clubId: string) => request<RatingBook>(clubPath(clubId, '/ratings')),

  addRoom: (clubId: string, body: { name: string; description?: string }) =>
    post<Room>(clubPath(clubId, '/rooms'), body),
  updateRoom: (clubId: string, roomId: string, body: { name?: string; description?: string }) =>
    put<{ ok: true }>(clubPath(clubId, `/rooms/${enc(roomId)}`), body),
  deleteRoom: (clubId: string, roomId: string) =>
    del<{ ok: true }>(clubPath(clubId, `/rooms/${enc(roomId)}`)),
  addTemplate: (clubId: string, roomId: string, body: TemplateInput) =>
    post<TableTemplate>(clubPath(clubId, `/rooms/${enc(roomId)}/templates`), body),
  updateTemplate: (clubId: string, templateId: string, body: Partial<TemplateInput>) =>
    put<{ ok: true }>(clubPath(clubId, `/templates/${enc(templateId)}`), body),
  deleteTemplate: (clubId: string, templateId: string) =>
    del<{ ok: true }>(clubPath(clubId, `/templates/${enc(templateId)}`)),

  tables: (clubId: string) => request<LobbyTable[]>(clubPath(clubId, '/tables')),
  closeTable: (clubId: string, tableId: string) =>
    post<{ ok: true }>(clubPath(clubId, `/tables/${enc(tableId)}/close`)),
  snapshot: (clubId: string, tableId: string) =>
    request<unknown>(clubPath(clubId, `/tables/${enc(tableId)}/snapshot`)),

  ledger: (clubId: string, opts: { offset?: number; limit?: number; kind?: LedgerKind } = {}) =>
    request<LedgerPage>(
      clubPath(
        clubId,
        `/ledger?offset=${opts.offset ?? 0}&limit=${opts.limit ?? 100}${opts.kind ? `&kind=${enc(opts.kind)}` : ''}`,
      ),
    ),
  verify: (clubId: string) => post<LedgerVerification>(clubPath(clubId, '/verify')),
  history: (clubId: string, filter: { member?: string; table?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.member) q.set('member', filter.member);
    if (filter.table) q.set('table', filter.table);
    const qs = q.toString();
    return request<HistoryRecord[]>(clubPath(clubId, `/history${qs ? `?${qs}` : ''}`));
  },
  statement: (clubId: string, memberId: string) =>
    request<MemberStatement>(clubPath(clubId, `/statements/${enc(memberId)}`)),

  operatorClubs: () => request<OperatorClub[]>('/operator/clubs'),
  operatorPurchases: () => request<PurchaseRow[]>('/operator/purchases'),
  markPaid: (purchaseId: string) =>
    post<PurchaseRow>(`/operator/purchases/${enc(purchaseId)}/paid`),
  operatorReport: () => request<OperatorReport>('/operator/report'),
};

// ---- server-sent events --------------------------------------------------------------------------

/** Event names the platform emits (`event: <type>`); unnamed events arrive as `message`. */
const EVENT_TYPES = [
  'club',
  'purchase',
  'error',
  'joined',
  'left',
  'member',
  'request',
  'sit',
  'leave',
  'created',
  'resumed',
  'closed',
  'table',
  'ledger',
  'result',
  'settings',
  'message',
];

function subscribe(
  path: string,
  onEvent: (event: PlatformEvent) => void,
  onState?: (state: 'open' | 'error') => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const token = getPlatformToken();
  const es = new EventSource(
    `${API_BASE}/api${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  );
  const handler = (ev: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(ev.data) as PlatformEvent;
      if (!parsed || typeof parsed.type !== 'string') return;
      if (parsed.data === undefined && typeof parsed.dataJson === 'string') {
        try {
          parsed.data = JSON.parse(parsed.dataJson);
        } catch {
          /* leave undefined */
        }
      }
      onEvent(parsed);
    } catch {
      /* ignore malformed */
    }
  };
  for (const type of EVENT_TYPES) es.addEventListener(type, handler as EventListener);
  es.onopen = () => onState?.('open');
  es.onerror = () => onState?.('error');
  return () => es.close();
}

export function subscribeClubEvents(
  clubId: string,
  onEvent: (event: PlatformEvent) => void,
  onState?: (state: 'open' | 'error') => void,
): () => void {
  return subscribe(clubPath(clubId, '/events'), onEvent, onState);
}

export function subscribeOperatorEvents(
  onEvent: (event: PlatformEvent) => void,
  onState?: (state: 'open' | 'error') => void,
): () => void {
  return subscribe('/operator/events', onEvent, onState);
}

/** The bytes the console signs to log in (mirrors the platform runtime's `loginBytes`). */
export function loginBytes(c: { profileId: string; publicKey: string; nonce: string }): Uint8Array {
  return new TextEncoder().encode(
    `p2p-platform login v1\n${c.profileId}\n${c.publicKey}\n${c.nonce}`,
  );
}
