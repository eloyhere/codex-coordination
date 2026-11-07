/**
 * JPA-style entity metadata construction: descriptors (payload encoding), column
 * metadata, indexes, unique constraints, associations and `@Version` columns.
 */
import type { Association, Column, EntityAccess, EntityDescriptor, EntityKind, Entity, Index, Key, UniqueConstraint } from "./types.js";
/** Options accepted by `jsonDescriptor`. */
export interface JsonDescriptorOptions<T> {
    readonly table?: string;
    readonly idOf: (entity: T) => string;
    readonly tenantOf?: (entity: T) => string | undefined;
    readonly sessionOf?: (entity: T) => string | undefined;
    readonly kindOf?: (entity: T) => string | undefined;
    readonly versionOf?: (entity: T) => number;
    readonly updatedAtOf?: (entity: T) => string;
}
/**
 * Asserts that a value is a complete `EntityDescriptor`: a known kind, a
 * non-empty table and every required function.
 */
export declare function assertDescriptor(descriptor: unknown): asserts descriptor is EntityDescriptor<unknown>;
/**
 * Builds a JSON descriptor for one aggregate. `payload` is the entity itself;
 * `decode` structured-clones it so callers never share references with the
 * encoded record. Version defaults to 0 and `updatedAt` defaults to now.
 */
export declare function jsonDescriptor<T>(kind: EntityKind, options: JsonDescriptorOptions<T>): EntityDescriptor<T>;
/** Options for `column`. */
export interface ColumnOptions {
    readonly column?: string;
    readonly nullable?: boolean;
    readonly unique?: boolean;
    readonly insertable?: boolean;
    readonly updatable?: boolean;
    readonly version?: boolean;
    readonly transient?: boolean;
    readonly length?: number;
    readonly precision?: number;
    readonly scale?: number;
}
/** Object-style argument for `column`. */
export interface ColumnInput extends ColumnOptions {
    readonly property: string;
}
/** Builds a `@Column` description; `column` defaults to the snake_case property. */
export declare function column(propertyOrInput: string | ColumnInput, options?: ColumnOptions): Column;
/** Options for `index`. */
export interface IndexOptions {
    readonly unique?: boolean;
}
/** Builds a `@Table(indexes = ...)` entry. */
export declare function index(name: string, columns: readonly string[], options?: IndexOptions): Index;
/** Builds a `@Table(uniqueConstraints = ...)` entry. */
export declare function uniqueConstraint(name: string, columns: readonly string[]): UniqueConstraint;
/** Entity metadata input; `indexes`, `uniqueConstraints`, `associations` and `descriptor` are optional. */
export interface EntityDefinition<T> {
    readonly kind: EntityKind;
    readonly table: string;
    readonly schema?: string;
    readonly access?: EntityAccess;
    readonly key: Key;
    readonly columns: readonly Column[];
    readonly indexes?: readonly Index[];
    readonly uniqueConstraints?: readonly UniqueConstraint[];
    readonly associations?: readonly Association[];
    readonly versionColumn?: string;
    readonly descriptor?: EntityDescriptor<T>;
}
/**
 * Builds and validates complete entity metadata: key properties map to columns,
 * column names are unique, index/unique-constraint columns exist, association
 * properties are unique with valid targets, and the `@Version` column exists
 * and is flagged as such.
 */
export declare function entity<T>(definition: EntityDefinition<T>): Entity<T>;
/** Alias of `entity` for call sites that prefer a declaration-like name. */
export declare function defineEntity<T>(definition: EntityDefinition<T>): Entity<T>;
