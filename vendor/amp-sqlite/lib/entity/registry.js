/**
 * Public entity registry. Concrete declarations live in `declarations.ts`; this
 * module only projects them into the frozen `EntityKind -> Entity` lookup that
 * the service and repository layers consume.
 */
import { ENTITY_DECLARATIONS } from "./declarations.js";
import { isEntityKind } from "./key.js";
export { entityKey } from "./key.js";
export { jsonDescriptor } from "./entity.js";
/** Explicit `Record` coverage makes a new `EntityKind` a compile-time obligation. */
export const ENTITY_REGISTRY = Object.freeze({
    ...ENTITY_DECLARATIONS,
});
export function descriptorFor(kind) {
    if (!isEntityKind(kind))
        throw new TypeError(`unknown entity kind: ${String(kind)}`);
    return ENTITY_REGISTRY[kind].descriptor;
}
