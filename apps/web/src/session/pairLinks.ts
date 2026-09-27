import { getTransportName, DEFAULT_TRANSPORT } from './providers';

/** Where a paired device goes afterwards: a path inside the player, e.g. `ofc/join/ABC234`. */
export function isSafeNext(next: string | null | undefined): next is string {
  return !!next && /^[a-z0-9][a-z0-9/-]*$/i.test(next) && !next.includes('..') && next.length < 128;
}

/** `#/pair/<code>` (plus `?next=`): opening it on another device starts pairing with this one. */
export function pairLink(code: string, next?: string): string {
  const query = isSafeNext(next) ? `?next=${next}` : '';
  const hash = `#/pair/${code}${query}`;
  if (typeof window === 'undefined') return hash;
  const { origin, pathname } = window.location;
  const transport = getTransportName();
  const t = transport === DEFAULT_TRANSPORT ? '' : `?transport=${transport}`;
  return `${origin}${pathname}${t}${hash}`;
}
