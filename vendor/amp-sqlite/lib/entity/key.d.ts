/**
 * Entity keys: runtime kind enumeration, record keys and JPA-style primary key
 * metadata (`@Id`, `@IdClass`, `@EmbeddedId`, `@GeneratedValue`).
 */
import type { EntityKind, IdStrategy, Key } from "./types.js";
/**
 * Runtime mirror of `EntityKind`. The registry is typed as a
 * `Record<EntityKind, ...>`, so the compiler enforces the same coverage; this
 * list lets runtime code validate foreign values and enumerate every kind.
 */
export declare const ENTITY_KINDS: readonly EntityKind[];
/** Every `IdStrategy` supported by the JPA metadata layer. */
export declare const ID_STRATEGIES: readonly IdStrategy[];
export declare function isEntityKind(value: unknown): value is EntityKind;
export declare function isIdStrategy(value: unknown): value is IdStrategy;
/** Stable record key used by caches and repositories: `` `${kind}:${id}` ``. */
export declare function entityKey(kind: EntityKind, id: string): string;
/** Options shared by `id`, `generatedId` and `compositeId`. */
export interface IdOptions {
    /** Property name for a single-property key; ignored by `compositeId`. */
    readonly property?: string;
    /** Explicit column name for a single-property key. */
    readonly column?: string;
    /** Explicit column names; must align one-to-one with the key properties. */
    readonly columns?: readonly string[];
    /** Generation strategy; `assigned` unless `generated` is requested. */
    readonly strategy?: IdStrategy;
    /** True for `@GeneratedValue`; mutually exclusive with `assigned`. */
    readonly generated?: boolean;
}
/** `tenantId` -> `tenant_id`, so a camelCase property maps to a snake_case column. */
export declare function toColumnName(property: string): string;
/**
 * Builds an assigned single-property primary key. `id()` defaults to the `id`
 * property and column; `id("key")` and `id({ property: "key", column: "key" })`
 * are also accepted.
 */
export declare function id(propertyOrOptions?: string | IdOptions, maybeOptions?: IdOptions): Key;
/**
 * Builds a generated single-property primary key (`@Id` + `@GeneratedValue`).
 * The strategy defaults to `auto`; `assigned` is rejected.
 */
export declare function generatedId(propertyOrOptions?: string | IdOptions, maybeOptions?: IdOptions): Key;
/** Builds a composite primary key; columns default to snake_case property names. */
export declare function compositeId(properties: readonly string[], options?: IdOptions): Key;
/** Asserts that a value is a complete, self-consistent `Key`. */
export declare function assertKey(value: unknown): asserts value is Key;
/**
 * Reads the key value(s) out of an entity. A single-property key returns the
 * bare value so it stays identical to `EntityDescriptor.keyOf`; a composite key
 * URI-encodes each part and joins them with `:`.
 */
export declare function keyOf(metadata: Key, entity: unknown): string;
