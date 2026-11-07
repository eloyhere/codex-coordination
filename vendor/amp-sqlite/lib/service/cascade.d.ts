/**
 * Cascade execution helpers.
 *
 * JPA metadata declares cascade types per association. This module decides
 * which declarations participate in one explicit `Store` operation, resolves
 * the reverse payload link used to find children, and defines the stable errors
 * raised when a cascade cannot run safely. Nothing here touches the database:
 * the store owns transactions, recursion and cache/identity invalidation.
 */
import type { Association } from "../entity/types.js";
/** Default maximum number of cascade edges below the root aggregate. */
export declare const DEFAULT_CASCADE_DEPTH = 8;
/** Stable failure codes for a rejected cascade. */
export type CascadeErrorCode = "cascade_cycle" | "cascade_depth" | "cascade_invalid";
/**
 * Raised when a cascade is rejected before it can produce a partial result:
 * a payload cycle, an exceeded depth limit, or an unknown cascade selector.
 * The message is prefixed with the code so `cascade_cycle` / `cascade_depth`
 * stay stable for callers and tests.
 */
export declare class CascadeError extends Error {
    readonly code: CascadeErrorCode;
    constructor(code: CascadeErrorCode, message: string);
}
/** Validates and defaults the {@link StoreOptions.cascadeDepth} setting. */
export declare function cascadeDepthOf(value: number | undefined): number;
/** Validates a `Store.save` cascade selector. */
export declare function saveCascadeOf(value: string | undefined): "none" | "persist" | "all";
/** Validates a `Store.remove` / `Store.removeCascade` cascade selector. */
export declare function removeCascadeOf(value: string | undefined): "none" | "remove" | "all";
/**
 * True when an association participates in `operation` under `mode`.
 *
 * `"all"` deliberately overrides the declaration; `"persist"` and `"remove"`
 * follow the declared metadata, with `orphanRemoval` acting as an implicit
 * remove cascade for composed children.
 */
export declare function associationCascades(association: Association, mode: "persist" | "remove" | "all", operation: "persist" | "remove"): boolean;
/**
 * Candidate payload properties on `target` that point back at this side.
 *
 * The explicit `joinProperty` wins; otherwise the JPA `mappedBy` property name
 * is tried as `<mappedBy>Id` and then verbatim, which covers the built-in
 * association conventions (`plan` -> `planId`, `session` -> `sessionId`).
 */
export declare function joinPropertiesOf(association: Association): readonly string[];
/**
 * Entity objects referenced by an association property value. A single object
 * and an array of objects are both accepted; primitives (ids) and arrays nested
 * inside the value are references, not cascade targets, and are left untouched.
 */
export declare function entityReferences(value: unknown): readonly Readonly<Record<string, unknown>>[];
/** Scalar entity ids referenced by an association property value. */
export declare function referenceIds(value: unknown): readonly string[];
