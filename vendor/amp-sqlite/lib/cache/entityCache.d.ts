import type { EntityCache, EntityCacheOptions } from "./types.js";
export declare function validateCacheOptions(options: EntityCacheOptions): void;
/** Reference-preserving entity cache; recency and capacity belong to the library LRU. */
export declare function createEntityCache(options?: Partial<EntityCacheOptions>): EntityCache;
