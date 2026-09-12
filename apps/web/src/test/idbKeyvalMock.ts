/** In-memory stand-in for idb-keyval, keyed by store name. Use with `vi.mock('idb-keyval', ...)`. */
export function createIdbKeyvalMock() {
  const dbs = new Map<string, Map<IDBValidKey, unknown>>();
  const storeFor = (s?: { name: string }) => {
    const name = s?.name ?? 'keyval';
    let m = dbs.get(name);
    if (!m) {
      m = new Map();
      dbs.set(name, m);
    }
    return m;
  };
  return {
    dbs,
    createStore: (dbName: string, storeName: string) => ({ name: `${dbName}/${storeName}` }),
    get: async (key: IDBValidKey, s?: { name: string }) => storeFor(s).get(key),
    set: async (key: IDBValidKey, value: unknown, s?: { name: string }) => {
      storeFor(s).set(key, value);
    },
    del: async (key: IDBValidKey, s?: { name: string }) => {
      storeFor(s).delete(key);
    },
    keys: async (s?: { name: string }) => Array.from(storeFor(s).keys()),
    clear: async (s?: { name: string }) => storeFor(s).clear(),
  };
}
