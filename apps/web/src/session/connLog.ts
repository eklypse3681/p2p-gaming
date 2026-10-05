/**
 * A small connection log kept on the device so a player can copy it from a phone and hand it
 * over when tables will not connect. Survives reloads (localStorage), keeps the last few hundred
 * lines, and never records keys, profiles or game state: only what the network did.
 */

const KEY = 'bgf:connlog';
const MAX_LINES = 400;

let lines: string[] | null = null;

function load(): string[] {
  if (lines) return lines;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    lines = Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    lines = [];
  }
  return lines;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines ?? []));
  } catch {
    /* storage full or blocked: the in-memory copy still works for this page */
  }
}

function stamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Record one event, e.g. `connLog('join:open', { code })`. */
export function connLog(event: string, detail?: Record<string, unknown>): void {
  const list = load();
  let line = `${stamp(new Date())} ${event}`;
  if (detail && Object.keys(detail).length) {
    try {
      line += ` ${JSON.stringify(detail)}`;
    } catch {
      /* unserialisable detail: the event name alone will do */
    }
  }
  list.push(line);
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES);
  save();
}

export function readConnLog(): string[] {
  return [...load()];
}

export function clearConnLog(): void {
  lines = [];
  save();
}

/** The log with a header naming the device, ready to paste into a bug report. */
export function formatConnLog(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  const visible = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  const online = typeof navigator !== 'undefined' ? navigator.onLine : 'unknown';
  const header = [
    `Among Friends connection log, copied ${new Date().toISOString()}`,
    `page ${typeof location !== 'undefined' ? location.href : ''}`,
    `agent ${ua}`,
    `online ${String(online)} visibility ${visible}`,
    '',
  ];
  return [...header, ...load()].join('\n');
}

/** Copy the log, or open the share sheet where copying is not allowed. Resolves to what happened. */
export async function shareConnLog(): Promise<'copied' | 'shared' | 'failed'> {
  const text = formatConnLog();
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    /* fall through to the share sheet */
  }
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Connection log', text });
      return 'shared';
    }
  } catch {
    /* dismissed */
  }
  return 'failed';
}

interface Watchable {
  getState(): {
    status: string;
    error?: { code: string; message: string } | null;
    rejectReason?: string | null;
  };
  subscribe(listener: () => void): () => void;
}

/** Log every status change of a client (joined, disconnected, rejected and why). */
export function logStatusChanges(client: Watchable, label: string): void {
  let last = '';
  const check = () => {
    const s = client.getState();
    if (s.status === last) return;
    last = s.status;
    connLog(`${label} status:${s.status}`, {
      ...(s.rejectReason ? { reject: s.rejectReason } : {}),
      ...(s.error ? { error: s.error.code, message: s.error.message } : {}),
    });
  };
  client.subscribe(check);
  check();
}
