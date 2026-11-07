import type { EntityDescriptor } from "../entity/types.js";
import type { Repository, RepositoryContext } from "./types.js";
/**
 * Creates the SQLite-backed repository for one entity descriptor.
 *
 * Reads use the supplied cache as a read-through layer. Writes persist the
 * descriptor's encoded record, invalidate the cached aggregate and store the
 * written aggregate back into the cache. When the context carries a tenant and
 * the filter/record omits one, the context tenant becomes the default scope.
 */
export declare function createSqliteRepository<T>(descriptor: EntityDescriptor<T>, context: RepositoryContext): Repository<T>;
