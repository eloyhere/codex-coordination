/**
 * JPA-style association metadata: `@OneToOne`, `@OneToMany`, `@ManyToOne`,
 * `@ManyToMany`, `@JoinColumn`, `@JoinTable`, `@OrderBy` and cascade options.
 */
import type { AssociationKind, Association, CascadeType, EntityKind, FetchType } from "./types.js";
export declare const CASCADE_TYPES: readonly CascadeType[];
export declare const FETCH_TYPES: readonly FetchType[];
export declare function isCascadeType(value: unknown): value is CascadeType;
export declare function isFetchType(value: unknown): value is FetchType;
export declare function isAssociationKind(value: unknown): value is AssociationKind;
/** Options accepted by every association constructor. */
export interface AssociationOptions {
    readonly mappedBy?: string;
    readonly targetProperty?: string;
    readonly joinProperty?: string;
    readonly joinTable?: string;
    readonly joinColumns?: readonly string[];
    readonly inverseJoinColumns?: readonly string[];
    readonly cascade?: readonly CascadeType[];
    readonly fetch?: FetchType;
    readonly orphanRemoval?: boolean;
    readonly optional?: boolean;
    readonly orderBy?: string;
}
/** Object-style constructor argument; `property` and `target` are mandatory. */
export interface AssociationInput extends AssociationOptions {
    readonly property: string;
    readonly target: EntityKind;
    readonly kind?: AssociationKind;
}
/** Builds a de-duplicated, frozen cascade list; values outside `CascadeType` throw. */
export declare function cascade(...types: CascadeType[]): readonly CascadeType[];
/**
 * Validates and freezes an association. It enforces JPA ownership rules:
 * `mappedBy` belongs to the inverse side of `one_to_many`/`many_to_many`, an
 * owning `many_to_many` needs a join table, and `orphanRemoval` is limited to
 * to-one/to-many compositions.
 */
export declare function normalizeAssociation(value: unknown): Association;
/** Asserts that a value is valid association metadata. */
export declare function assertAssociation(value: unknown): asserts value is Association;
export declare function oneToOne(property: string, target: EntityKind, options?: AssociationOptions): Association;
export declare function oneToOne(input: AssociationInput): Association;
export declare function oneToMany(property: string, target: EntityKind, options?: AssociationOptions): Association;
export declare function oneToMany(input: AssociationInput): Association;
export declare function manyToOne(property: string, target: EntityKind, options?: AssociationOptions): Association;
export declare function manyToOne(input: AssociationInput): Association;
export declare function manyToMany(property: string, target: EntityKind, options?: AssociationOptions): Association;
export declare function manyToMany(input: AssociationInput): Association;
