import { SynchronousOrderedLRUMap } from "semantic-typescript";
export function validateCacheOptions(options) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
        throw new RangeError("maxEntries must be a positive safe integer");
    }
    if (!Number.isFinite(options.ttlMilliseconds) || options.ttlMilliseconds < 0) {
        throw new RangeError("ttlMilliseconds must be a non-negative finite number");
    }
}
function timestamp(now) {
    const result = Date.parse(now);
    if (!Number.isFinite(result))
        throw new TypeError("cache now must be a valid timestamp");
    return result;
}
/** Reference-preserving entity cache; recency and capacity belong to the library LRU. */
export function createEntityCache(options = {}) {
    const settings = { maxEntries: options.maxEntries ?? 1024, ttlMilliseconds: options.ttlMilliseconds ?? 60_000 };
    validateCacheOptions(settings);
    const entries = new SynchronousOrderedLRUMap(undefined, { capacity: BigInt(settings.maxEntries) });
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    let expirations = 0;
    return {
        get(key, now) {
            const time = timestamp(now);
            const entry = entries.get(key);
            if (entry.isEmpty()) {
                misses++;
                return undefined;
            }
            if (time >= entry.get().expiresAt) {
                entries.remove(key);
                expirations++;
                misses++;
                return undefined;
            }
            hits++;
            return entry.get().value;
        },
        set(key, value, now) {
            const time = timestamp(now);
            const expired = [];
            entries.forEach((entryKey, entry) => { if (time >= entry.expiresAt)
                expired.push(entryKey); });
            for (const expiredKey of expired) {
                entries.remove(expiredKey);
                expirations++;
            }
            if (!entries.containsKey(key) && entries.size() >= BigInt(settings.maxEntries))
                evictions++;
            entries.put(key, { value, expiresAt: time + settings.ttlMilliseconds });
        },
        has: key => entries.containsKey(key),
        delete: key => entries.remove(key).isPresent(),
        invalidate(predicate) {
            const keys = [];
            entries.forEach(key => { if (predicate(key))
                keys.push(key); });
            for (const key of keys)
                entries.remove(key);
            return keys.length;
        },
        clear: () => entries.clear(),
        stats() {
            return Object.freeze({ entries: Number(entries.size()), hits, misses, evictions, expirations, hitRate: hits + misses === 0 ? 0 : hits / (hits + misses) });
        },
    };
}
