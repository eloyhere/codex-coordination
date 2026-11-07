import type { Association, EntityFilter, EntityKind, EntityState, EventRecord } from "../entity/types.js";
import type { EventQuery, RemoveOptions, RemoveReport, SaveOptions, StoreOptions, StoreStats } from "./types.js";
/** Default hidden directory under the current working directory. */
export declare const DEFAULT_STORE_DIRECTORY = ".attention-manifest-protocol";
/** Default SQLite file name inside {@link DEFAULT_STORE_DIRECTORY}. */
export declare const DEFAULT_STORE_FILE = "store.sqlite";
interface IndexReport {
    readonly applied: readonly string[];
    readonly skipped: readonly string[];
}
/**
 * SQLite-backed service store with a JPA-style persistence context.
 *
 * A single proxy per identity exists for the lifetime of a database path
 * (module-level identity table), even across `Store` instances. Proxies load on
 * first read and write through on every mutation with optimistic
 * compare-and-swap. `transaction` uses the shared connection pool and nested
 * savepoints; writes participate immediately, so a thrown error rolls back rows,
 * cache and loaded proxy state together.
 */
export declare class Store {
    static open(options?: StoreOptions): Store;
    readonly path: string;
    private readonly identityPath;
    private readonly pool;
    private readonly driver;
    private readonly cache;
    private transactionContext;
    private readonly connection;
    private readonly now;
    private readonly cascadeDepth;
    private readonly repositories;
    private readonly identities;
    private readonly detachedKeys;
    private readonly removedKeys;
    private readonly appliedIndexNames;
    private readonly skippedIndexNames;
    private activeTransactionWrites;
    private activeTransactionRemovals;
    private openState;
    private constructor();
    get open(): boolean;
    /** Declarative index application report (`@Index` / `@UniqueConstraint`). */
    get indexReport(): IndexReport;
    /** Returns the process-wide unique managed proxy; never reads the database here. */
    load<T>(kind: EntityKind, id: string): T | undefined;
    /** Eagerly checks existence, then returns the same managed proxy as {@link load}. */
    resolve<T>(kind: EntityKind, id: string): T;
    /**
     * Saves one aggregate.
     *
     * `cascade` defaults to `"none"`, which keeps the historical single-row
     * write. `"persist"` also saves the entity objects found on associations
     * whose declaration includes `persist`; `"all"` follows every association.
     * The root and every descendant are written in one transaction, so a
     * failing descendant rolls the root back as well. Cycle (`cascade_cycle`)
     * and depth (`cascade_depth`) violations raise a {@link CascadeError}.
     */
    save<T>(kind: EntityKind, entity: T, options?: SaveOptions): T;
    /** Writes exactly one row; cascade recursion calls this directly inside its transaction. */
    private saveEntity;
    /**
     * Removes one aggregate.
     *
     * `cascade` defaults to `"none"`, which keeps the historical single-row
     * delete. `"remove"` also deletes children found on associations whose
     * declaration includes `remove` or `orphanRemoval`; `"all"` follows every
     * association. The whole cascade is one transaction, and a graph deeper
     * than `StoreOptions.cascadeDepth` raises `cascade_depth`. Returns whether
     * the root row was deleted; use {@link removeCascade} to receive a count.
     */
    remove(kind: EntityKind, id: string, options?: RemoveOptions): boolean;
    /**
     * Cascade-aware {@link remove} that reports how many rows were deleted,
     * root included. With `"none"` the call is equivalent to `remove`.
     */
    removeCascade(kind: EntityKind, id: string, options?: RemoveOptions): RemoveReport;
    /** Deletes exactly one row and invalidates its cache and identity. */
    private removeEntity;
    private assertRemovalTarget;
    private cascadeRemove;
    /**
     * Depth-first removal of one identity and its cascade children. The row is
     * deleted before its descendants are visited so an exceeded depth limit
     * leaves provably deleted rows for the enclosing transaction to roll back.
     */
    private cascadeRemoveNode;
    /**
     * Child identities for one removed aggregate. Both sources are consulted:
     * references embedded in the parent payload (objects or scalar ids) and
     * child rows whose declared reverse link equals the parent id. The list is
     * scoped by the parent `sessionId` when the parent payload carries one.
     */
    private cascadeRemovalChildren;
    /**
     * Recursive save for one aggregate's cascade children. `path` holds the
     * identities of the current branch so a payload cycle is rejected instead
     * of recursing forever; `depth` counts edges below the transaction root.
     */
    private persistCascade;
    list<T>(kind: EntityKind, filter?: EntityFilter): readonly T[];
    appendEvent(kind: string, payload: unknown, entityId?: string): void;
    events(options?: EventQuery): readonly EventRecord[];
    /** JPA lifecycle state for an identity in this persistence context. */
    state(kind: EntityKind, id: string): EntityState;
    /**
     * Detaches an identity from the persistence context. The old proxy keeps
     * serving its local snapshot but subsequent writes stay local and are not
     * written through; `load`/`resolve` create a fresh managed proxy.
     */
    detach(kind: EntityKind, id: string): void;
    /** Forces a re-read from the repository and replaces the managed snapshot. */
    refresh<T>(kind: EntityKind, id: string): T;
    /**
     * Association declarations of a kind. The metadata drives the opt-in
     * cascades of {@link save}/{@link remove}; this method exposes it for
     * inspection without executing anything.
     */
    cascadePlan(kind: EntityKind, id: string): readonly Association[];
    /**
     * Runs `work` inside a pooled writer transaction. Writes use the same
     * connection, so they participate in the transaction; on failure the SQL
     * transaction rolls back, the cache is cleared and every entity touched by
     * the transaction is marked unloaded so the next read re-reads the database.
     */
    transaction<T>(work: (store: Store) => T): T;
    stats(): StoreStats;
    close(): void;
    private assertOpen;
    private slotKey;
    private descriptor;
    private repository;
    private getOrCreateSlot;
    private liveOwner;
    private hydrate;
    private loadSlot;
    private containerOf;
    private toPlainSnapshot;
    /** Applies one mutation to a copy, bumps the version and writes through with CAS. */
    private commit;
    private writeProperty;
    private removeProperty;
    private mutateArray;
    private handler;
    private nestedProxy;
    private noteWrite;
    private invalidateSlot;
    private applyJpaIndexes;
    private applyIndex;
}
export {};
