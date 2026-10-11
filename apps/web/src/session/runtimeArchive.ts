/**
 * Shared by the runtime archive's functions (`functions/runtime-archive`, `/api/archive-runtime`):
 * the few R2 and Pages bits they use (no workers-types here), what may be stored, and the
 * deployed runtime's manifest.
 */
export interface R2Object {
  body: ReadableStream;
}
export interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<unknown>;
  put(
    key: string,
    value: ArrayBuffer | string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}
export interface ArchiveEnv {
  RUNTIMES?: R2Bucket;
  ASSETS: { fetch(req: Request | string): Promise<Response> };
}

/** A runtime file's path inside the build (and the archive): content-hashed JavaScript only. */
export const FILE_PATH = /^(runtime|assets)\/[\w.-]+\.js$/;
/** A runtime id, as `RUNTIME_ID` gives it. */
export const PIN = /^runtime-[\w-]+\.js$/;

export const pinKey = (id: string) => `pins/${id}.json`;

export interface RuntimeManifest {
  id: string;
  version: string;
  entry: string;
  files: { path: string; sha256: string }[];
}

export async function currentManifest(
  request: Request,
  env: ArchiveEnv,
): Promise<RuntimeManifest | null> {
  try {
    const res = await env.ASSETS.fetch(new URL('/runtime/manifest.json', request.url).toString());
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<RuntimeManifest>;
    return typeof m.id === 'string' && typeof m.entry === 'string' && Array.isArray(m.files)
      ? (m as RuntimeManifest)
      : null;
  } catch {
    return null;
  }
}
