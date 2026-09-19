import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitOpts {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
}

const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'p2p-platform',
  GIT_AUTHOR_EMAIL: 'platform@p2p.local',
  GIT_COMMITTER_NAME: 'p2p-platform',
  GIT_COMMITTER_EMAIL: 'platform@p2p.local',
  // Deterministic timestamps keep repeated bench runs comparable.
  GIT_AUTHOR_DATE: '2026-09-13T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-09-13T00:00:00Z',
};

/** Run a git command synchronously; returns trimmed stdout, throws GitError on failure. */
export function git(args: string[], opts: GitOpts): string {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...BASE_ENV, ...opts.env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new GitError(args, r.status, r.stderr ?? '');
  return (r.stdout ?? '').trim();
}

/** Like `git` but never throws. */
export function gitTry(
  args: string[],
  opts: GitOpts,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...BASE_ENV, ...opts.env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/**
 * A long-lived `git fast-import` process. Commands stream in; `sync()` sends a `checkpoint`
 * (packfile closed, refs written) followed by a `get-mark`, whose answer on the cat-blob fd
 * proves everything before it has been processed. This is the fast path for hand commits.
 */
export class FastImport {
  private proc: ChildProcess;
  private pendingResolvers: Array<(line: string) => void> = [];
  private buffer = '';
  private nextMark = 1;
  private closed = false;

  constructor(cwd: string) {
    this.proc = spawn('git', ['fast-import', '--quiet', '--cat-blob-fd=3', '--done'], {
      cwd,
      env: { ...process.env, ...BASE_ENV },
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    const fd3 = this.proc.stdio[3] as NodeJS.ReadableStream;
    fd3.setEncoding('utf8');
    fd3.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.pendingResolvers.shift()?.(line);
      }
    });
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => {
      this.lastStderr += d;
    });
  }
  lastStderr = '';

  private write(text: string): void {
    if (this.closed) throw new Error('fast-import closed');
    this.proc.stdin!.write(text);
  }

  /** Orphan commit with a single file; the ref is written at the next checkpoint. */
  commitFile(ref: string, path: string, content: string, message: string): number {
    const mark = this.nextMark++;
    const data = Buffer.from(content, 'utf8');
    this.write(
      `commit ${ref}\n` +
        `mark :${mark}\n` +
        `committer p2p-platform <platform@p2p.local> 1789257600 +0000\n` +
        `data ${Buffer.byteLength(message)}\n${message}\n` +
        `deleteall\n` +
        `M 100644 inline ${path}\n` +
        `data ${data.length}\n`,
    );
    this.proc.stdin!.write(data);
    this.write('\n');
    return mark;
  }

  /**
   * Commit onto an existing ref (or create it) changing only the given paths; the rest of the
   * tree is inherited from the ref's current tip. This is the fast path for hot-state commits.
   */
  commitOnto(
    ref: string,
    files: Record<string, string>,
    message: string,
    hasParent: boolean,
  ): number {
    const mark = this.nextMark++;
    let text =
      `commit ${ref}\n` +
      `mark :${mark}\n` +
      `committer p2p-platform <platform@p2p.local> 1789257600 +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}\n`;
    if (hasParent) text += `from ${ref}^0\n`;
    this.write(text);
    for (const [path, content] of Object.entries(files)) {
      const data = Buffer.from(content, 'utf8');
      this.write(`M 100644 inline ${path}\ndata ${data.length}\n`);
      this.proc.stdin!.write(data);
      this.write('\n');
    }
    this.write('\n');
    return mark;
  }

  /** Checkpoint (refs + pack durable) and wait until fast-import has processed it. */
  async sync(mark: number): Promise<string> {
    this.write('checkpoint\n');
    const answer = new Promise<string>((resolve) => this.pendingResolvers.push(resolve));
    this.write(`get-mark :${mark}\n`);
    return answer;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proc.stdin!.end('done\n');
    await new Promise<void>((resolve) => this.proc.on('close', () => resolve()));
  }
}
