import { generateId } from '@bgf/protocol';
import { readJson, writeJson } from '../storage';

/** Identifies this browser among a player's devices (random, kept in localStorage). */
export interface DeviceInfo {
  id: string;
  label: string;
}

export const DEVICE_KEY = 'p2p:device';

/** "Chrome · macOS", "Safari · iPhone", … from a user-agent string. */
export function deviceLabelFromUA(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'device';
  return `${browser} · ${os}`;
}

export function getDevice(): DeviceInfo {
  const stored = readJson<Partial<DeviceInfo>>(DEVICE_KEY);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const label = deviceLabelFromUA(ua);
  if (stored && typeof stored.id === 'string' && stored.id) {
    if (stored.label !== label) writeJson(DEVICE_KEY, { id: stored.id, label });
    return { id: stored.id, label };
  }
  const info = { id: generateId(), label };
  writeJson(DEVICE_KEY, info);
  return info;
}
