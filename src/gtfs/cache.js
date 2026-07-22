const store = new Map();
/** In-flight loaders so concurrent cold misses share one promise. */
const pending = new Map();

/**
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} loader
 * @returns {Promise<T>}
 */
export async function cached(key, ttlMs, loader) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const value = await loader();
      store.set(key, { at: Date.now(), value });
      return value;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

/** Drop one key (e.g. after GTFS zip refresh). */
export function cacheDelete(key) {
  store.delete(key);
  pending.delete(key);
}

/** Drop all keys that start with prefix (e.g. `static:muni`). */
export function cacheDeletePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
}
