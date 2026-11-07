/**
 * Public entity registry. Concrete declarations live in `declarations.ts`; this
 * module only projects them into the frozen `EntityKind -> Entity` lookup that
 * the service and repository layers consume.
 */
import type { DeclaredEntity } from "./declarations.js";
import type { EntityDescriptor, EntityKind } from "./types.js";
export { entityKey } from "./key.js";
export { jsonDescriptor } from "./entity.js";
/** Explicit `Record` coverage makes a new `EntityKind` a compile-time obligation. */
export declare const ENTITY_REGISTRY: Readonly<Record<EntityKind, DeclaredEntity>>;
export declare function descriptorFor<T = unknown>(kind: EntityKind): EntityDescriptor<T>;
