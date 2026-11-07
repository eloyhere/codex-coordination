import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createEntityCache } from "../cache/index.js";
import { createConnectionPool } from "../connection/index.js";
import { ENTITY_REGISTRY, descriptorFor, entityKey } from "../entity/index.js";
import { appendEvent as appendRepositoryEvent, createSqliteRepository, readEvents } from "../repository/index.js";
import { migrate, openSqlite, schemaVersion } from "../sql/index.js";
import { associationCascades, CascadeError, cascadeDepthOf, entityReferences, joinPropertiesOf, referenceIds, removeCascadeOf, saveCascadeOf, } from "./cascade.js";
/** Default hidden directory under the current working directory. */
export const DEFAULT_STORE_DIRECTORY = ".attention-manifest-protocol";
/** Default SQLite file name inside {@link DEFAULT_STORE_DIRECTORY}. */
export const DEFAULT_STORE_FILE = "store.sqlite";
const CLOSED_MESSAGE = "store is closed";
const NOT_FOUND_MESSAGE = "not_found";
/** Marker used to recognise our own proxies without exporting a private symbol. */
const PROXY_MARKER = Symbol.for("attention-manifest-protocol.store.proxy");
const ARRAY_MUTATORS = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);
/** Process-wide identity table: `<absolute database path>#<kind>:<id>`. */
const identities = new Map();
const poolsByPath = new Map();
let memorySequence = 0;
function isOpenable(value) {
    return value.length > 0;
}
/** Canonical absolute file path; a directory receives the default file name. */
function storeFileOf(input) {
    if (input === undefined || input.length === 0) {
        return join(resolve(process.cwd()), DEFAULT_STORE_DIRECTORY, DEFAULT_STORE_FILE);
    }
    if (input === ":memory:")
        return input;
    const absolute = resolve(input);
    let existing;
    try {
        existing = statSync(absolute);
    }
    catch {
        existing = undefined;
    }
    if (existing?.isDirectory() === true)
        return join(absolute, DEFAULT_STORE_FILE);
    if (existing?.isFile() === true)
        return absolute;
    if (/\.sqlite$/i.test(absolute))
        return absolute;
    return join(absolute, DEFAULT_STORE_FILE);
}
/** Lower-cases only the Windows drive letter, keeping the rest of the path stable. */
function canonicalFile(file) {
    if (file === ":memory:" || process.platform !== "win32")
        return file;
    return file.charAt(0).toLowerCase() + file.slice(1);
}
function isProxyable(value) {
    return typeof value === "object" && value !== null;
}
function isThenable(value) {
    return isProxyable(value) && typeof value.then === "function";
}
function readAtPath(value, path) {
    let current = value;
    for (const key of path) {
        if (current === null || current === undefined)
            return undefined;
        current = current[key];
    }
    return current;
}
function writeAtPath(root, path, property, value) {
    const container = path.length === 0 ? root : readAtPath(root, path);
    if (container === null || typeof container !== "object")
        throw new TypeError("cannot write through a missing container");
    container[property] = value;
}
function deleteAtPath(root, path, property) {
    const container = path.length === 0 ? root : readAtPath(root, path);
    if (container === null || typeof container !== "object")
        return true;
    return Reflect.deleteProperty(container, property);
}
/** Deep copy that unwraps our own proxies and detaches caller-owned objects. */
function plainCopy(value) {
    if (!isProxyable(value))
        return value;
    if (value[PROXY_MARKER] === true) {
        return plainCopy(value.toJSON());
    }
    if (Array.isArray(value))
        return value.map((item) => plainCopy(item));
    const output = {};
    for (const key of Object.keys(value))
        output[key] = plainCopy(value[key]);
    return output;
}
function cloneEntity(entity) {
    try {
        return structuredClone(entity);
    }
    catch {
        return plainCopy(entity);
    }
}
function versionOf(descriptor, entity) {
    const value = descriptor.versionOf(entity);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function syncArrayTarget(container, target) {
    if (!Array.isArray(container)) {
        target.length = 0;
        return;
    }
    target.length = container.length;
    for (let index = 0; index < container.length; index += 1) {
        if (index in container)
            target[index] = container[index];
        else
            delete target[index];
    }
}
function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function countRows(driver, table) {
    const rows = driver.query({ sql: `SELECT COUNT(*) AS count FROM ${table}` });
    const value = rows[0]?.count ?? 0;
    return typeof value === "bigint" ? Number(value) : value;
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
export class Store {
    static open(options = {}) {
        // Validate cascade policy before a database connection is opened.
        cascadeDepthOf(options.cascadeDepth);
        const file = storeFileOf(options.path);
        const identityPath = file === ":memory:" ? `${file}#${++memorySequence}` : canonicalFile(file);
        return new Store(file, identityPath, options);
    }
    path;
    identityPath;
    pool;
    driver;
    cache;
    transactionContext;
    connection;
    now;
    cascadeDepth;
    repositories = new Map();
    identities = new Set();
    detachedKeys = new Set();
    removedKeys = new Set();
    appliedIndexNames = [];
    skippedIndexNames = [];
    activeTransactionWrites;
    activeTransactionRemovals;
    openState;
    constructor(path, identityPath, options) {
        this.path = path;
        this.identityPath = identityPath;
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true });
        this.now = options.now ?? (() => new Date().toISOString());
        this.cascadeDepth = cascadeDepthOf(options.cascadeDepth);
        const pooled = poolsByPath.get(identityPath);
        if (pooled !== undefined) {
            this.pool = pooled.pool;
            this.connection = pooled.connection;
            this.driver = pooled.connection.driver;
            pooled.owners.add(this);
        }
        else {
            let connection;
            this.pool = createConnectionPool({
                maxConnections: 1,
                open: () => openSqlite({
                    path,
                    wal: options.wal ?? true,
                    foreignKeys: true,
                    busyTimeoutMilliseconds: 5_000,
                }),
            });
            try {
                connection = this.pool.acquire();
                this.connection = connection;
                this.driver = connection.driver;
                migrate(this.driver);
                this.applyJpaIndexes();
            }
            catch (error) {
                connection?.release();
                this.pool.close();
                throw error;
            }
            poolsByPath.set(identityPath, { pool: this.pool, connection: this.connection, owners: new Set([this]) });
        }
        this.cache = createEntityCache(options.cache);
        this.openState = true;
    }
    get open() {
        return this.openState;
    }
    /** Declarative index application report (`@Index` / `@UniqueConstraint`). */
    get indexReport() {
        return {
            applied: Object.freeze([...this.appliedIndexNames]),
            skipped: Object.freeze([...this.skippedIndexNames]),
        };
    }
    /** Returns the process-wide unique managed proxy; never reads the database here. */
    load(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        return this.getOrCreateSlot(kind, id).proxy;
    }
    /** Eagerly checks existence, then returns the same managed proxy as {@link load}. */
    resolve(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        const descriptor = this.descriptor(kind);
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        const entity = owner.repository(kind).get(id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            throw new Error(NOT_FOUND_MESSAGE);
        }
        owner.hydrate(slot, entity, descriptor);
        return slot.proxy;
    }
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
    save(kind, entity, options = {}) {
        this.assertOpen();
        const cascade = saveCascadeOf(options.cascade);
        if (cascade === "none")
            return this.saveEntity(kind, entity, options);
        if (!isProxyable(entity))
            throw new TypeError("entity must be an object");
        const snapshot = cloneEntity(entity);
        const rootKey = entityKey(kind, this.descriptor(kind).keyOf(entity));
        return this.transaction((transaction) => {
            const saved = transaction.saveEntity(kind, entity, options);
            transaction.persistCascade(kind, snapshot, cascade, 0, new Set([rootKey]));
            return saved;
        });
    }
    /** Writes exactly one row; cascade recursion calls this directly inside its transaction. */
    saveEntity(kind, entity, options = {}) {
        this.assertOpen();
        if (!isProxyable(entity))
            throw new TypeError("entity must be an object");
        const descriptor = this.descriptor(kind);
        const id = descriptor.keyOf(entity);
        if (!isOpenable(id))
            throw new Error("entity key is empty");
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        const record = descriptor.encode(entity);
        const canonical = descriptor.decode({
            ...record,
            version: Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0,
            updatedAt: typeof record.updatedAt === "string" && record.updatedAt.length > 0 ? record.updatedAt : owner.now(),
        });
        const written = owner.repository(kind).put(canonical, options);
        owner.hydrate(slot, written, descriptor);
        owner.noteWrite(slot.key);
        return slot.proxy;
    }
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
    remove(kind, id, options = {}) {
        this.assertOpen();
        this.assertRemovalTarget(kind, id);
        const cascade = removeCascadeOf(options.cascade);
        if (cascade === "none")
            return this.removeEntity(kind, id);
        return this.cascadeRemove(kind, id, cascade).removed > 0;
    }
    /**
     * Cascade-aware {@link remove} that reports how many rows were deleted,
     * root included. With `"none"` the call is equivalent to `remove`.
     */
    removeCascade(kind, id, options = {}) {
        this.assertOpen();
        this.assertRemovalTarget(kind, id);
        const cascade = removeCascadeOf(options.cascade);
        if (cascade === "none")
            return { removed: this.removeEntity(kind, id) ? 1 : 0 };
        return this.cascadeRemove(kind, id, cascade);
    }
    /** Deletes exactly one row and invalidates its cache and identity. */
    removeEntity(kind, id) {
        const removed = this.repository(kind).delete(id);
        if (!removed)
            return false;
        const key = this.slotKey(kind, id);
        this.detachedKeys.delete(key);
        this.removedKeys.add(key);
        this.activeTransactionRemovals?.add(key);
        const slot = identities.get(key);
        if (slot !== undefined) {
            identities.delete(key);
            slot.state = "removed";
            slot.target = undefined;
            slot.owners.clear();
        }
        this.identities.delete(key);
        return true;
    }
    assertRemovalTarget(kind, id) {
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
    }
    cascadeRemove(kind, id, cascade) {
        return this.transaction((transaction) => {
            const removed = { count: 0 };
            transaction.cascadeRemoveNode(kind, id, cascade, 0, new Set(), removed);
            return { removed: removed.count };
        });
    }
    /**
     * Depth-first removal of one identity and its cascade children. The row is
     * deleted before its descendants are visited so an exceeded depth limit
     * leaves provably deleted rows for the enclosing transaction to roll back.
     */
    cascadeRemoveNode(kind, id, cascade, depth, visited, removed) {
        const key = entityKey(kind, id);
        if (visited.has(key))
            return false;
        visited.add(key);
        if (depth > this.cascadeDepth) {
            throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${key}`);
        }
        const entity = this.repository(kind).get(id);
        if (entity === undefined)
            return false;
        // Child ids are resolved before the parent row disappears.
        const children = this.cascadeRemovalChildren(kind, id, entity, cascade);
        const deleted = this.removeEntity(kind, id);
        if (deleted)
            removed.count += 1;
        for (const child of children) {
            this.cascadeRemoveNode(child.kind, child.id, cascade, depth + 1, visited, removed);
        }
        return deleted;
    }
    /**
     * Child identities for one removed aggregate. Both sources are consulted:
     * references embedded in the parent payload (objects or scalar ids) and
     * child rows whose declared reverse link equals the parent id. The list is
     * scoped by the parent `sessionId` when the parent payload carries one.
     */
    cascadeRemovalChildren(kind, id, entity, cascade) {
        const children = [];
        const seen = new Set();
        for (const association of ENTITY_REGISTRY[kind].associations) {
            if (!associationCascades(association, cascade, "remove"))
                continue;
            const target = association.target;
            const descriptor = this.descriptor(target);
            const add = (childId) => {
                const childKey = entityKey(target, childId);
                if (seen.has(childKey))
                    return;
                seen.add(childKey);
                children.push({ kind: target, id: childId });
            };
            const referenced = entity[association.property];
            for (const reference of entityReferences(referenced)) {
                try {
                    add(descriptor.keyOf(reference));
                }
                catch {
                    // A payload may embed a non-entity reference; it is not a child.
                }
            }
            for (const referenceId of referenceIds(referenced))
                add(referenceId);
            // A many-to-many join table is not materialised in the row schema;
            // embedded references above are its only available source.
            if (association.kind === "many_to_many")
                continue;
            const joinProperties = joinPropertiesOf(association);
            if (joinProperties.length === 0)
                continue;
            // Session scoping is the primary lookup. Payloads that do not carry
            // a sessionId (or carry a different one) are still found by the
            // declared reverse link through an unscoped pass.
            const parentSession = typeof entity.sessionId === "string" && entity.sessionId.length > 0
                ? entity.sessionId
                : undefined;
            const candidates = parentSession === undefined
                ? this.list(target)
                : [...this.list(target, { sessionId: parentSession }), ...this.list(target)];
            for (const child of candidates) {
                const record = child;
                if (joinProperties.some(property => record[property] === id))
                    add(descriptor.keyOf(child));
            }
        }
        return children;
    }
    /**
     * Recursive save for one aggregate's cascade children. `path` holds the
     * identities of the current branch so a payload cycle is rejected instead
     * of recursing forever; `depth` counts edges below the transaction root.
     */
    persistCascade(kind, entity, cascade, depth, path) {
        if (depth > this.cascadeDepth) {
            throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${kind}`);
        }
        for (const association of ENTITY_REGISTRY[kind].associations) {
            if (!associationCascades(association, cascade, "persist"))
                continue;
            const childKind = association.target;
            for (const child of entityReferences(entity[association.property])) {
                const childId = this.descriptor(childKind).keyOf(child);
                const childKey = entityKey(childKind, childId);
                if (path.has(childKey)) {
                    throw new CascadeError("cascade_cycle", `cascade path revisits ${childKey}`);
                }
                const childDepth = depth + 1;
                if (childDepth > this.cascadeDepth) {
                    throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${childKey}`);
                }
                this.saveEntity(childKind, child, {});
                path.add(childKey);
                try {
                    this.persistCascade(childKind, child, cascade, childDepth, path);
                }
                finally {
                    path.delete(childKey);
                }
            }
        }
    }
    list(kind, filter) {
        this.assertOpen();
        const descriptor = this.descriptor(kind);
        const entities = this.repository(kind).list(filter);
        return entities.map((entity) => {
            const slot = this.getOrCreateSlot(kind, descriptor.keyOf(entity));
            this.liveOwner(slot).hydrate(slot, entity, descriptor);
            return slot.proxy;
        });
    }
    appendEvent(kind, payload, entityId) {
        this.assertOpen();
        if (typeof kind !== "string" || kind.length === 0)
            throw new TypeError("event kind must be a non-empty string");
        appendRepositoryEvent(this.driver, {
            kind,
            payload,
            ...(entityId === undefined ? {} : { entityId }),
            recordedAt: this.now(),
        });
    }
    events(options = {}) {
        this.assertOpen();
        return readEvents(this.driver, options);
    }
    /** JPA lifecycle state for an identity in this persistence context. */
    state(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        const slot = identities.get(key);
        if (slot !== undefined)
            return slot.state;
        if (this.removedKeys.has(key))
            return "removed";
        if (this.detachedKeys.has(key))
            return "detached";
        return this.repository(kind).get(id) === undefined ? "new" : "detached";
    }
    /**
     * Detaches an identity from the persistence context. The old proxy keeps
     * serving its local snapshot but subsequent writes stay local and are not
     * written through; `load`/`resolve` create a fresh managed proxy.
     */
    detach(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        this.removedKeys.delete(key);
        this.detachedKeys.add(key);
        this.cache.delete(entityKey(kind, id));
        const slot = identities.get(key);
        if (slot !== undefined) {
            identities.delete(key);
            slot.state = "detached";
            slot.owners.add(this);
        }
        this.identities.delete(key);
    }
    /** Forces a re-read from the repository and replaces the managed snapshot. */
    refresh(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        const descriptor = this.descriptor(kind);
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        for (const holder of slot.owners)
            holder.cache.delete(entityKey(kind, id));
        const entity = owner.repository(kind).get(id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            throw new Error(NOT_FOUND_MESSAGE);
        }
        owner.hydrate(slot, entity, descriptor);
        return slot.proxy;
    }
    /**
     * Association declarations of a kind. The metadata drives the opt-in
     * cascades of {@link save}/{@link remove}; this method exposes it for
     * inspection without executing anything.
     */
    cascadePlan(kind, id) {
        this.assertOpen();
        if (!isOpenable(id))
            throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        void id;
        return Object.freeze([...ENTITY_REGISTRY[kind].associations]);
    }
    /**
     * Runs `work` inside a pooled writer transaction. Writes use the same
     * connection, so they participate in the transaction; on failure the SQL
     * transaction rolls back, the cache is cleared and every entity touched by
     * the transaction is marked unloaded so the next read re-reads the database.
     */
    transaction(work) {
        this.assertOpen();
        const outermost = this.activeTransactionWrites === undefined;
        if (outermost) {
            this.activeTransactionWrites = new Set();
            this.activeTransactionRemovals = new Set();
        }
        const transaction = outermost ? this.connection.startTransaction() : this.transactionContext;
        if (transaction === undefined)
            throw new Error("transaction context is unavailable");
        const savePoint = outermost ? undefined : transaction.savePoint();
        const previousTransaction = this.transactionContext;
        this.transactionContext = transaction;
        try {
            const result = work(this);
            if (isThenable(result))
                throw new TypeError("transaction work must be synchronous");
            if (savePoint !== undefined)
                savePoint.release();
            else
                transaction.commit();
            return result;
        }
        catch (error) {
            if (savePoint !== undefined)
                savePoint.rollback();
            else if (transaction.state === "active")
                transaction.rollback();
            this.cache.clear();
            for (const key of this.activeTransactionWrites ?? [])
                this.invalidateSlot(key);
            for (const key of this.activeTransactionRemovals ?? []) {
                this.removedKeys.delete(key);
                this.detachedKeys.delete(key);
            }
            this.activeTransactionWrites?.clear();
            this.activeTransactionRemovals?.clear();
            throw error;
        }
        finally {
            this.transactionContext = previousTransaction;
            if (outermost) {
                this.activeTransactionWrites = undefined;
                this.activeTransactionRemovals = undefined;
            }
        }
    }
    stats() {
        this.assertOpen();
        return {
            entities: countRows(this.driver, "entities"),
            events: countRows(this.driver, "events"),
            identity: this.identities.size,
            cache: this.cache.stats(),
            schemaVersion: schemaVersion(this.driver),
        };
    }
    close() {
        if (!this.openState)
            return;
        this.openState = false;
        for (const key of this.identities) {
            const slot = identities.get(key);
            if (slot === undefined)
                continue;
            slot.owners.delete(this);
            if (slot.owners.size === 0) {
                identities.delete(key);
                slot.closed = true;
                slot.target = undefined;
                slot.version = 0;
                slot.loaded = false;
            }
        }
        this.identities.clear();
        this.detachedKeys.clear();
        this.removedKeys.clear();
        this.repositories.clear();
        this.cache.clear();
        const pooled = poolsByPath.get(this.identityPath);
        if (pooled !== undefined && pooled.owners.has(this)) {
            pooled.owners.delete(this);
            if (pooled.owners.size === 0) {
                poolsByPath.delete(this.identityPath);
                this.connection.release();
                this.pool.close();
            }
        }
    }
    assertOpen() {
        if (!this.openState)
            throw new Error(CLOSED_MESSAGE);
    }
    slotKey(kind, id) {
        return `${this.identityPath}#${entityKey(kind, id)}`;
    }
    descriptor(kind) {
        return descriptorFor(kind);
    }
    repository(kind) {
        const existing = this.repositories.get(kind);
        if (existing !== undefined)
            return existing;
        const descriptor = this.descriptor(kind);
        const repository = createSqliteRepository(descriptor, { driver: this.driver, cache: this.cache, now: this.now });
        this.repositories.set(kind, repository);
        return repository;
    }
    getOrCreateSlot(kind, id) {
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        const existing = identities.get(key);
        if (existing !== undefined && existing.state === "managed") {
            existing.owners.add(this);
            this.identities.add(key);
            return existing;
        }
        this.detachedKeys.delete(key);
        this.removedKeys.delete(key);
        const slot = {
            key,
            kind,
            id,
            proxy: {},
            owners: new Set(),
            target: undefined,
            version: 0,
            loaded: false,
            missing: false,
            state: "managed",
            closed: false,
        };
        slot.proxy = new Proxy({}, this.handler(slot, []));
        slot.owners.add(this);
        identities.set(key, slot);
        this.identities.add(key);
        return slot;
    }
    liveOwner(slot) {
        if (slot.state === "removed")
            throw new Error(NOT_FOUND_MESSAGE);
        if (slot.closed)
            throw new Error(CLOSED_MESSAGE);
        for (const owner of slot.owners) {
            if (owner.openState)
                return owner;
        }
        slot.closed = true;
        throw new Error(CLOSED_MESSAGE);
    }
    hydrate(slot, entity, descriptor) {
        slot.target = cloneEntity(entity);
        slot.version = versionOf(descriptor, entity);
        slot.loaded = true;
        slot.missing = false;
        slot.state = "managed";
    }
    loadSlot(slot, owner) {
        const descriptor = owner.descriptor(slot.kind);
        const entity = owner.repository(slot.kind).get(slot.id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            return;
        }
        owner.hydrate(slot, entity, descriptor);
    }
    containerOf(slot, path) {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded)
            owner.loadSlot(slot, owner);
        if (path.length === 0)
            return slot.target;
        return readAtPath(slot.target, path);
    }
    toPlainSnapshot(slot, path) {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded)
            owner.loadSlot(slot, owner);
        return plainCopy(path.length === 0 ? slot.target : readAtPath(slot.target, path));
    }
    /** Applies one mutation to a copy, bumps the version and writes through with CAS. */
    commit(slot, mutate) {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded)
            owner.loadSlot(slot, owner);
        if (slot.target === undefined)
            throw new Error(NOT_FOUND_MESSAGE);
        const next = cloneEntity(slot.target);
        const result = mutate(next);
        if (slot.state === "detached") {
            // Detached entities keep a local snapshot; writes never reach SQLite.
            slot.target = next;
            return result;
        }
        const descriptor = owner.descriptor(slot.kind);
        const record = descriptor.encode(next);
        const version = slot.version + 1;
        const updatedAt = owner.now();
        const canonical = descriptor.decode({
            ...record,
            version,
            updatedAt,
        });
        const written = owner.repository(slot.kind).put(canonical, { expectedVersion: slot.version });
        owner.hydrate(slot, written, descriptor);
        owner.noteWrite(slot.key);
        return result;
    }
    writeProperty(slot, path, property, value) {
        if (typeof property === "symbol")
            throw new TypeError("symbol properties are not persisted");
        this.commit(slot, (root) => writeAtPath(root, path, property, plainCopy(value)));
        return true;
    }
    removeProperty(slot, path, property) {
        if (typeof property === "symbol")
            return true;
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded)
            owner.loadSlot(slot, owner);
        const container = path.length === 0 ? slot.target : readAtPath(slot.target, path);
        if (container === undefined || container === null)
            return true;
        if (!Reflect.has(container, property))
            return true;
        this.commit(slot, (root) => deleteAtPath(root, path, property));
        return true;
    }
    mutateArray(slot, path, method, args) {
        const plainArgs = args.map((argument) => plainCopy(argument));
        return this.commit(slot, (root) => {
            const array = readAtPath(root, path);
            if (!Array.isArray(array))
                throw new TypeError("array mutator called on a non-array value");
            const operation = Array.prototype[method];
            return operation.apply(array, plainArgs);
        });
    }
    handler(slot, path, arrayTarget) {
        const array = arrayTarget !== undefined;
        return {
            get: (target, property) => {
                if (property === PROXY_MARKER)
                    return true;
                if (property === "toJSON")
                    return () => this.toPlainSnapshot(slot, path);
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined)
                    syncArrayTarget(container, arrayTarget);
                if (array && Array.isArray(container) && typeof property === "string" && ARRAY_MUTATORS.has(property)) {
                    return (...args) => this.mutateArray(slot, path, property, args);
                }
                if (array && property === "length")
                    return arrayTarget.length;
                if (container === null || container === undefined)
                    return undefined;
                const value = container[property];
                if (isProxyable(value))
                    return this.nestedProxy(slot, [...path, property], value);
                void target;
                return value;
            },
            set: (_target, property, value) => this.writeProperty(slot, path, property, value),
            deleteProperty: (_target, property) => this.removeProperty(slot, path, property),
            has: (_target, property) => {
                const container = this.containerOf(slot, path);
                return isProxyable(container) && property in container;
            },
            ownKeys: (target) => {
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined) {
                    syncArrayTarget(container, arrayTarget);
                    return Reflect.ownKeys(target);
                }
                return isProxyable(container) ? Reflect.ownKeys(container) : [];
            },
            getOwnPropertyDescriptor: (target, property) => {
                if (arrayTarget !== undefined && property === "length") {
                    return Object.getOwnPropertyDescriptor(target, "length");
                }
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined)
                    syncArrayTarget(container, arrayTarget);
                if (!isProxyable(container))
                    return undefined;
                const descriptor = Object.getOwnPropertyDescriptor(container, property);
                if (descriptor === undefined)
                    return undefined;
                return { ...descriptor, configurable: true };
            },
        };
    }
    nestedProxy(slot, path, value) {
        if (!Array.isArray(value))
            return new Proxy({}, this.handler(slot, path));
        const target = [];
        syncArrayTarget(value, target);
        return new Proxy(target, this.handler(slot, path, target));
    }
    noteWrite(key) {
        this.activeTransactionWrites?.add(key);
    }
    invalidateSlot(key) {
        const slot = identities.get(key);
        if (slot === undefined)
            return;
        slot.loaded = false;
        slot.missing = false;
        slot.target = undefined;
        slot.version = 0;
    }
    applyJpaIndexes() {
        const columns = new Set();
        for (const row of this.driver.query({ sql: "PRAGMA table_info(entities)" })) {
            if (typeof row.name === "string")
                columns.add(row.name);
        }
        const declared = new Set();
        for (const metadata of Object.values(ENTITY_REGISTRY)) {
            for (const index of metadata.indexes) {
                this.applyIndex(index.name, index.columns, index.unique, columns, declared);
            }
            for (const constraint of metadata.uniqueConstraints) {
                this.applyIndex(constraint.name, constraint.columns, true, columns, declared);
            }
        }
    }
    applyIndex(name, indexColumns, unique, available, declared) {
        if (declared.has(name))
            return;
        if (name.length === 0 || indexColumns.length === 0 || !indexColumns.every((column) => available.has(column))) {
            this.skippedIndexNames.push(name);
            return;
        }
        declared.add(name);
        try {
            this.driver.exec(`CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(name)} `
                + `ON entities (${indexColumns.map(quoteIdentifier).join(", ")})`);
            this.appliedIndexNames.push(name);
        }
        catch {
            this.skippedIndexNames.push(name);
        }
    }
}
