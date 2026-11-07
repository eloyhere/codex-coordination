import type { CacheStats } from "./types.js";
export interface CachingProxyOptions {
    readonly maxEntries?: number;
    readonly ttlMilliseconds?: number;
    readonly readMethods?: readonly string[];
    readonly writeMethods?: readonly string[];
    /** byArgs invalidates cached reads whose complete argument tuple matches the write. */
    readonly invalidation?: "all" | "byArgs";
    readonly now?: () => number;
    readonly serializeArguments?: (args: readonly unknown[]) => string;
}
export interface CacheProxyHandle<T extends object = object> {
    readonly proxy: T;
    stats(): CacheStats;
    clear(): void;
    invalidateAll(): void;
    invalidate(key: string): boolean;
}
/** Tagged tuples distinguish undefined/null, numeric edge cases and nested argument shapes. */
export declare function stableSerializeArguments(args: readonly unknown[]): string;
export declare function cacheKey(method: string, args: readonly unknown[], serialize?: typeof stableSerializeArguments): string;
/** Create a service Proxy and a separate management handle; no business methods are added. */
export declare function createCacheProxyHandle<T extends object>(service: T, options?: CachingProxyOptions): CacheProxyHandle<T>;
/** Returns the actual business Proxy. Use getCacheProxyHandle for management. */
export declare function createCachingProxy<T extends object>(service: T, options?: CachingProxyOptions): T;
export declare function getCacheProxyHandle<T extends object>(proxy: T): CacheProxyHandle<T>;
