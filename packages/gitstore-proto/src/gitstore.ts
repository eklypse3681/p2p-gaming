import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FastImport, GitError, git, gitTry } from './git.ts';

/**
 * Layout A — "hot tree + push-only hand refs".
 *
 * - `refs/heads/main` holds ONLY current state (club state, table snapshots, chain heads).
 * - Every hand/transaction batch is an orphan commit (no parent) reachable from
 *   `refs/hands/<club>/<table>/<n>` (or a daily bucket). These refs are pushed and then dropped
 *   locally, so the working repository stays small while the remote keeps the full record.
 * - Restore clones `main` only; a hand is fetched on demand by exact ref.
 * - Hand records carry a SHA-256 chain (`prevHash`/`hash`) so integrity is verifiable from the
 *   records alone, without walking git history.
 */

export interface HandRecordInput {
  clubId: string;
  tableId: string;
  hand: number;
  at: number;
  entries: unknown[];
  actions: unknown[];
}

export interface HandRecord extends HandRecordInput {
  prevHash: string;
  hash: string;
}

export interface ChainHead {
  hand: number;
  hash: string;
}

export type Bucket = 'table' | 'day';

export interface StoreOptions {
  remote?: string;
  bucket?: Bucket;
  /** Hand commits via a long-lived fast-import process instead of plumbing spawns. */
  fastImport?: boolean;
  /** Hot-state commits through the same fast-import process (requires `fastImport`). */
  fastImportState?: boolean;
  /** Branch that holds the hot tree (layout B uses one per club). */
  branch?: string;
}

export interface StoreStatus {
  head: string | null;
  unpushedHands: number;
  mainPushed: boolean;
  localBytes: number;
  looseObjects: number;
  packedBytes: number;
  lastPushAt: number | null;
  lastPushError: string | null;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function chainKey(clubId: string, tableId: string): string {
  return `${clubId}/${tableId}`;
}

export function handRef(
  clubId: string,
  tableId: string,
  hand: number,
  bucket: Bucket,
  at: number,
): string {
  if (bucket === 'day') {
    const d = new Date(at).toISOString().slice(0, 10).replace(/-/g, '');
    return `refs/hands/${clubId}/${d}/${tableId}-${hand}`;
  }
  return `refs/hands/${clubId}/${tableId}/${hand}`;
}

export class GitStore {
  readonly dir: string;
  readonly gitDir: string;
  readonly branch: string;
  private readonly bucket: Bucket;
  private readonly remote: string | null;
  private heads = new Map<string, ChainHead>();
  private fi: FastImport | null = null;
  private fiState = false;
  private branchExists = false;
  private lastPushAt: number | null = null;
  private lastPushError: string | null = null;
  private indexFile: string;

  private constructor(dir: string, opts: StoreOptions) {
    this.dir = dir;
    this.gitDir = join(dir, '.git');
    this.branch = opts.branch ?? 'main';
    this.bucket = opts.bucket ?? 'table';
    this.remote = opts.remote ?? null;
    this.indexFile = join(this.gitDir, `hot-${this.branch.replace(/\//g, '_')}.index`);
    if (opts.fastImport) this.fi = new FastImport(dir);
    this.fiState = !!(opts.fastImport && opts.fastImportState);
  }

  /** Open (or initialise) a repository in `dir`; optionally wire `origin`. */
  static open(dir: string, opts: StoreOptions = {}): GitStore {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      git(['init', '-q', '-b', 'main'], { cwd: dir });
      git(['config', 'gc.auto', '0'], { cwd: dir });
      git(['config', 'protocol.version', '2'], { cwd: dir });
      if (opts.remote) git(['remote', 'add', 'origin', opts.remote], { cwd: dir });
    }
    const store = new GitStore(dir, opts);
    store.loadHeads();
    return store;
  }

  /** Clone `main` only (no history of hands, no tags) and open it. */
  static restore(dir: string, remote: string, opts: Omit<StoreOptions, 'remote'> = {}): GitStore {
    const branch = opts.branch ?? 'main';
    git(
      [
        '-c',
        'protocol.version=2',
        'clone',
        '-q',
        '--single-branch',
        '--branch',
        branch,
        '--no-tags',
        remote,
        dir,
      ],
      { cwd: process.cwd() },
    );
    git(['config', 'gc.auto', '0'], { cwd: dir });
    git(['config', 'protocol.version', '2'], { cwd: dir });
    const store = new GitStore(dir, { ...opts, remote });
    // Rebuild the persistent index from the branch tree so partial updates work.
    git(['read-tree', branch], { cwd: dir, env: { GIT_INDEX_FILE: store.indexFile } });
    store.loadHeads();
    return store;
  }

  private loadHeads(): void {
    const raw = this.readState('chains.json');
    this.heads = new Map();
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, ChainHead>)) this.heads.set(k, v);
    }
  }

  /** Current head commit of the hot branch, or null. */
  head(): string | null {
    const r = gitTry(['rev-parse', '--verify', '-q', `refs/heads/${this.branch}`], {
      cwd: this.dir,
    });
    return r.code === 0 ? r.stdout : null;
  }

  /** Read a JSON file from the hot tree (null when absent). */
  readState(path: string): unknown {
    const r = gitTry(['cat-file', '-p', `refs/heads/${this.branch}:${path}`], { cwd: this.dir });
    if (r.code !== 0) return null;
    return JSON.parse(r.stdout) as unknown;
  }

  listState(): string[] {
    const r = gitTry(['ls-tree', '-r', '--name-only', `refs/heads/${this.branch}`], {
      cwd: this.dir,
    });
    return r.code === 0 && r.stdout ? r.stdout.split('\n') : [];
  }

  /**
   * Write/replace files in the hot tree and commit. Only the given paths change; the rest of the
   * tree is carried by the persistent index. Chain heads are always written to `chains.json`.
   */
  commitState(files: Record<string, unknown>, message = 'state'): string {
    const all: Record<string, unknown> = {
      ...files,
      'chains.json': Object.fromEntries(this.heads),
    };
    if (this.fi && this.fiState) {
      const hasParent = this.branchExists || this.head() !== null;
      const mark = this.fi.commitOnto(
        `refs/heads/${this.branch}`,
        Object.fromEntries(Object.entries(all).map(([k, v]) => [k, canonical(v)])),
        message,
        hasParent,
      );
      this.branchExists = true;
      this.lastStateMark = mark;
      return `:${mark}`;
    }
    const env = { GIT_INDEX_FILE: this.indexFile };
    const lines: string[] = [];
    for (const [path, value] of Object.entries(all)) {
      const blob = git(['hash-object', '-w', '--stdin'], {
        cwd: this.dir,
        input: canonical(value),
      });
      lines.push(`100644 ${blob}\t${path}`);
    }
    git(['update-index', '--add', '--index-info'], {
      cwd: this.dir,
      env,
      input: lines.join('\n') + '\n',
    });
    const tree = git(['write-tree'], { cwd: this.dir, env });
    const parent = this.head();
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
      cwd: this.dir,
    });
    git(['update-ref', `refs/heads/${this.branch}`, commit], { cwd: this.dir });
    return commit;
  }

  /** Append a hand record as an orphan commit under its own ref; returns the ref and hash. */
  appendHand(input: HandRecordInput): { ref: string; hash: string; mark?: number } {
    const key = chainKey(input.clubId, input.tableId);
    const prev = this.heads.get(key);
    const prevHash = prev?.hash ?? 'genesis';
    if (prev && input.hand !== prev.hand + 1) {
      throw new Error(`hand ${input.hand} does not follow ${prev.hand} for ${key}`);
    }
    const body: Omit<HandRecord, 'hash'> = { ...input, prevHash };
    const hash = sha256(canonical(body));
    const record: HandRecord = { ...body, hash };
    const ref = handRef(input.clubId, input.tableId, input.hand, this.bucket, input.at);
    const content = canonical(record);
    let mark: number | undefined;
    if (this.fi) {
      mark = this.fi.commitFile(ref, 'hand.json', content, `hand ${key} #${input.hand}`);
    } else {
      const blob = git(['hash-object', '-w', '--stdin'], { cwd: this.dir, input: content });
      const tree = git(['mktree'], { cwd: this.dir, input: `100644 blob ${blob}\thand.json\n` });
      const commit = git(['commit-tree', tree, '-m', `hand ${key} #${input.hand}`], {
        cwd: this.dir,
      });
      git(['update-ref', ref, commit], { cwd: this.dir });
    }
    this.heads.set(key, { hand: input.hand, hash });
    if (mark !== undefined) this.lastHandMark = mark;
    return { ref, hash, mark };
  }

  lastStateMark = 0;

  /** fast-import mode: make everything appended so far durable (refs written). */
  async flushHands(mark: number): Promise<void> {
    if (this.fi) await this.fi.sync(mark);
  }

  /** fast-import mode: checkpoint everything (hands and state) written so far. */
  async flush(): Promise<void> {
    if (!this.fi) return;
    const mark = Math.max(this.lastStateMark, this.lastHandMark);
    if (mark > 0) await this.fi.sync(mark);
  }
  private lastHandMark = 0;

  chainHead(clubId: string, tableId: string): ChainHead | undefined {
    return this.heads.get(chainKey(clubId, tableId));
  }

  /** Local hand refs not yet pushed. */
  localHandRefs(): string[] {
    const r = gitTry(['for-each-ref', '--format=%(refname)', 'refs/hands/'], { cwd: this.dir });
    return r.code === 0 && r.stdout ? r.stdout.split('\n') : [];
  }

  /**
   * Push the hot branch and every local hand ref. On success the hand refs are deleted locally
   * (the remote holds them); their objects linger until `pruneLocal()`.
   */
  pushAll(): { ok: boolean; hands: number; error?: string } {
    if (!this.remote) return { ok: true, hands: 0 };
    const hands = this.localHandRefs();
    const specs = [
      ...(this.head() ? [`refs/heads/${this.branch}:refs/heads/${this.branch}`] : []),
      ...hands.map((h) => `${h}:${h}`),
    ];
    if (specs.length === 0) return { ok: true, hands: 0 };
    const r = gitTry(['push', '-q', 'origin', ...specs], { cwd: this.dir });
    if (r.code !== 0) {
      this.lastPushError = r.stderr.split('\n').slice(-1)[0] ?? 'push failed';
      return { ok: false, hands: 0, error: r.stderr };
    }
    if (hands.length) {
      git(['update-ref', '--stdin'], {
        cwd: this.dir,
        input: hands.map((h) => `delete ${h}\n`).join(''),
      });
    }
    this.lastPushAt = Date.now();
    this.lastPushError = null;
    return { ok: true, hands: hands.length };
  }

  /** Drop objects only reachable from already-pushed hand refs; repack what remains. */
  pruneLocal(): { beforeBytes: number; afterBytes: number } {
    const before = this.status().localBytes;
    git(['reflog', 'expire', '--expire=now', '--all'], { cwd: this.dir });
    git(['gc', '-q', '--prune=now'], { cwd: this.dir });
    return { beforeBytes: before, afterBytes: this.status().localBytes };
  }

  /** Fetch one hand by exact ref from the remote and return its record. */
  fetchHand(clubId: string, tableId: string, hand: number, at = 0): HandRecord {
    if (!this.remote) throw new Error('no remote');
    const ref = handRef(clubId, tableId, hand, this.bucket, at);
    const tmp = `refs/tmp/hand-${process.pid}`;
    git(['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', 'origin', `${ref}:${tmp}`], {
      cwd: this.dir,
    });
    const text = git(['cat-file', '-p', `${tmp}:hand.json`], { cwd: this.dir });
    git(['update-ref', '-d', tmp], { cwd: this.dir });
    return JSON.parse(text) as HandRecord;
  }

  /** Hand numbers the remote holds for a table (via ls-remote on the ref prefix). */
  remoteHands(clubId: string, tableId: string): number[] {
    if (!this.remote) return [];
    const r = git(['ls-remote', '--refs', 'origin', `refs/hands/${clubId}/${tableId}/*`], {
      cwd: this.dir,
    });
    return r
      .split('\n')
      .filter(Boolean)
      .map((l) => Number(l.split('/').pop()))
      .sort((a, b) => a - b);
  }

  status(): StoreStatus {
    const counts = Object.fromEntries(
      git(['count-objects', '-v'], { cwd: this.dir })
        .split('\n')
        .map((l) => l.split(': '))
        .map(([k, v]) => [k, Number(v)]),
    ) as Record<string, number>;
    const localBytes = (counts['size'] ?? 0) * 1024 + (counts['size-pack'] ?? 0) * 1024;
    const remoteHead = gitTry(
      ['rev-parse', '--verify', '-q', `refs/remotes/origin/${this.branch}`],
      { cwd: this.dir },
    );
    const head = this.head();
    return {
      head,
      unpushedHands: this.localHandRefs().length,
      mainPushed: !this.remote || (remoteHead.code === 0 && remoteHead.stdout === head),
      localBytes,
      looseObjects: counts['count'] ?? 0,
      packedBytes: (counts['size-pack'] ?? 0) * 1024,
      lastPushAt: this.lastPushAt,
      lastPushError: this.lastPushError,
    };
  }

  /** Verify a sequence of records forms an unbroken chain from `genesis`. */
  static verifyChain(records: HandRecord[]): { ok: boolean; brokenAt?: number } {
    let prev = 'genesis';
    for (const r of records) {
      const { hash, ...body } = r;
      if (body.prevHash !== prev || sha256(canonical(body)) !== hash)
        return { ok: false, brokenAt: r.hand };
      prev = hash;
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.fi) {
      await this.fi.close();
      this.fi = null;
    }
  }

  /** Delete the working repository (tests/bench). */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export { GitError, git, gitTry };
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
