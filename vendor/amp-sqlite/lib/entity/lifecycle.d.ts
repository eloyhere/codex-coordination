/**
 * JPA-style entity lifecycle callbacks and state transitions.
 *
 * The metadata layer describes what is persisted; this module describes when a
 * host may run callbacks around that work. It is deliberately side-effect free:
 * callbacks receive the entity and a small context and cannot return a
 * replacement entity. Persistence itself stays in `Store`/repositories.
 */
import type { EntityKind, EntityState } from "./types.js";
/** Callbacks defined by JPA around the persistence context (`@PrePersist`, ...). */
export type EntityLifecycleEvent = "prePersist" | "postPersist" | "preUpdate" | "postUpdate" | "preRemove" | "postRemove" | "postLoad";
export declare const ENTITY_LIFECYCLE_EVENTS: readonly EntityLifecycleEvent[];
/** Runtime mirror of `EntityState`, including the terminal `deleted` alias. */
export declare const ENTITY_STATES: readonly EntityState[];
export declare function isEntityState(value: unknown): value is EntityState;
export declare function isEntityLifecycleEvent(value: unknown): value is EntityLifecycleEvent;
export declare function assertEntityState(value: unknown, label?: string): asserts value is EntityState;
export declare function assertLifecycleEvent(value: unknown): asserts value is EntityLifecycleEvent;
/**
 * `deleted` is a reserved terminal alias of `removed`. The transition table
 * does not enter it, so callers that persist the word `deleted` should
 * normalize it to `removed` before asserting a transition. It is never an
 * origin, which keeps a terminal entity from being resurrected through an alias.
 */
export declare function normalizeLifecycleState(state: EntityState): EntityState;
/**
 * Legal JPA persistence-context transitions. `deleted` is intentionally listed
 * as a terminal state but is not entered by the table; it is a reserved alias
 * for persisted values, not a distinct persistence-context destination.
 */
export declare const LIFECYCLE_TRANSITIONS: Readonly<Record<EntityState, readonly EntityState[]>>;
/**
 * Asserts one persistence-context transition. Throws `TypeError` for unknown
 * states and for edges absent from {@link LIFECYCLE_TRANSITIONS}. `deleted` is
 * deliberately not entered by the table; normalize it with
 * {@link normalizeLifecycleState} first when reading persisted values.
 */
export declare function assertLifecycleTransition(from: EntityState, to: EntityState): void;
/** Callback context for one lifecycle event. */
export interface EntityLifecycleContext {
    readonly kind: EntityKind;
    readonly state: EntityState;
    readonly version: number;
    readonly now: string;
}
/** Asserts that a value is a complete {@link EntityLifecycleContext}. */
export declare function assertEntityLifecycleContext(value: unknown): asserts value is EntityLifecycleContext;
/** One optional callback per JPA lifecycle event. */
export interface EntityLifecycle<T> {
    readonly prePersist?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postPersist?: (entity: T, context: EntityLifecycleContext) => void;
    readonly preUpdate?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postUpdate?: (entity: T, context: EntityLifecycleContext) => void;
    readonly preRemove?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postRemove?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postLoad?: (entity: T, context: EntityLifecycleContext) => void;
}
/** Frozen result of one dispatcher call. */
export interface LifecycleDispatchResult {
    /** Number of registered callbacks invoked for the event. */
    readonly invoked: number;
    /** Errors thrown by `post*` callbacks, in invocation order. */
    readonly errors: readonly Error[];
}
export interface LifecycleDispatcher<T> {
    /** Appends one callback object; callbacks run in registration order. */
    register(hooks: EntityLifecycle<T>): LifecycleDispatcher<T>;
    fire(event: EntityLifecycleEvent, entity: T, context: EntityLifecycleContext): LifecycleDispatchResult;
}
/**
 * Creates a dispatcher over zero or more callback objects. A single callback
 * object and an array of them are both accepted; `register` can append more.
 * `pre*` failures abort the call immediately, while `post*` failures are
 * collected so independent cleanup callbacks still run.
 */
export declare function createLifecycleDispatcher<T = unknown>(hooks?: EntityLifecycle<T> | readonly EntityLifecycle<T>[]): LifecycleDispatcher<T>;
/**
 * Registry of lifecycle callbacks per `EntityKind`. One callback object may be
 * registered per kind; registering twice is rejected so a kind's callbacks stay
 * predictable. Firing a kind that has no registered callbacks is a no-op.
 */
export declare class LifecycleRegistry {
    private readonly hooks;
    private readonly dispatchers;
    constructor(initial?: Readonly<Partial<Record<EntityKind, EntityLifecycle<unknown>>>>);
    register<T>(kind: EntityKind, hooks: EntityLifecycle<T>): this;
    has(kind: EntityKind): boolean;
    get(kind: EntityKind): EntityLifecycle<unknown> | undefined;
    /** Registered kinds in registration order. */
    kinds(): readonly EntityKind[];
    fire<T = unknown>(kind: EntityKind, event: EntityLifecycleEvent, entity: T, context: EntityLifecycleContext): LifecycleDispatchResult;
}
