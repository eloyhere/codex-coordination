import type { EntityCache } from './types.js';
export interface ServiceProxyOptions {
    readonly namespace?: string;
    /** Explicit lists replace inference for their respective method category. */
    readonly readMethods?: readonly PropertyKey[];
    readonly writeMethods?: readonly PropertyKey[];
    readonly now?: () => string;
}
export interface ServiceProxyStats {
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
    readonly invalidations: number;
    readonly hitRate: number;
}
/** Snapshots are independent of the backing cache's aggregate statistics. */
export declare function getServiceProxyStats(proxy: object): ServiceProxyStats | undefined;
/** Cache service results; this layer does not manage entity identities. */
export declare function createServiceProxy<T extends object>(service: T, cache: EntityCache, options?: ServiceProxyOptions): T;
export declare class ServiceRegistry {
    private readonly cache;
    private readonly services;
    constructor(cache: EntityCache);
    register<T extends object>(name: string, service: T, options?: ServiceProxyOptions): T;
    get<T extends object = object>(name: string): T | undefined;
    remove(name: string): boolean;
    list(): string[];
}
/** Automatically register services in a registry scoped to the supplied cache. */
export declare function registerService<T extends object>(cache: EntityCache, name: string, service: T, options?: ServiceProxyOptions): T;
