import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom's localStorage can be missing/partial under some Node versions; provide a compliant shim.
if (
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.clear !== 'function'
) {
  const backing = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k: string) => backing.get(k) ?? null,
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => {
      backing.delete(k);
    },
    setItem: (k: string, v: string) => {
      backing.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true });
}
