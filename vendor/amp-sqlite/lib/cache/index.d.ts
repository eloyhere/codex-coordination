export type { EntityCacheOptions, CacheStats, EntityCache } from "./types.js";
export { createEntityCache } from "./entityCache.js";
export type { CachingProxyOptions, CacheProxyHandle } from "./proxy.js";
export { cacheKey, stableSerializeArguments, createCachingProxy, createCacheProxyHandle, getCacheProxyHandle } from "./proxy.js";
export type { ServiceProxyOptions, ServiceProxyStats } from "./serviceProxy.js";
export { createServiceProxy, getServiceProxyStats, registerService, ServiceRegistry } from "./serviceProxy.js";
