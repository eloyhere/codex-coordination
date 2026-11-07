/**
 * JPA-style entity lifecycle callbacks and state transitions.
 *
 * The metadata layer describes what is persisted; this module describes when a
 * host may run callbacks around that work. It is deliberately side-effect free:
 * callbacks receive the entity and a small context and cannot return a
 * replacement entity. Persistence itself stays in `Store`/repositories.
 */
import { isEntityKind } from "./key.js";
export const ENTITY_LIFECYCLE_EVENTS = Object.freeze([
    "prePersist",
    "postPersist",
    "preUpdate",
    "postUpdate",
    "preRemove",
    "postRemove",
    "postLoad",
]);
/** Runtime mirror of `EntityState`, including the terminal `deleted` alias. */
export const ENTITY_STATES = Object.freeze([
    "new",
    "managed",
    "detached",
    "removed",
    "deleted",
]);
export function isEntityState(value) {
    return typeof value === "string" && ENTITY_STATES.includes(value);
}
export function isEntityLifecycleEvent(value) {
    return typeof value === "string" && ENTITY_LIFECYCLE_EVENTS.includes(value);
}
export function assertEntityState(value, label = "entity state") {
    if (!isEntityState(value))
        throw new TypeError(`${label} is not a known entity state: ${String(value)}`);
}
export function assertLifecycleEvent(value) {
    if (!isEntityLifecycleEvent(value))
        throw new TypeError(`unknown entity lifecycle event: ${String(value)}`);
}
/**
 * `deleted` is a reserved terminal alias of `removed`. The transition table
 * does not enter it, so callers that persist the word `deleted` should
 * normalize it to `removed` before asserting a transition. It is never an
 * origin, which keeps a terminal entity from being resurrected through an alias.
 */
export function normalizeLifecycleState(state) {
    return state === "deleted" ? "removed" : state;
}
const transitions = (values) => Object.freeze([...values]);
const TRANSITION_TABLE = {
    new: transitions(["managed"]),
    managed: transitions(["detached", "removed"]),
    detached: transitions(["managed", "removed"]),
    removed: transitions([]),
    deleted: transitions([]),
};
/**
 * Legal JPA persistence-context transitions. `deleted` is intentionally listed
 * as a terminal state but is not entered by the table; it is a reserved alias
 * for persisted values, not a distinct persistence-context destination.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze(TRANSITION_TABLE);
/**
 * Asserts one persistence-context transition. Throws `TypeError` for unknown
 * states and for edges absent from {@link LIFECYCLE_TRANSITIONS}. `deleted` is
 * deliberately not entered by the table; normalize it with
 * {@link normalizeLifecycleState} first when reading persisted values.
 */
export function assertLifecycleTransition(from, to) {
    if (!isEntityState(from) || !isEntityState(to)) {
        throw new TypeError(`unknown lifecycle transition: ${String(from)} -> ${String(to)}`);
    }
    if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
        throw new TypeError(`invalid lifecycle transition: ${from} -> ${to}`);
    }
}
/** Asserts that a value is a complete {@link EntityLifecycleContext}. */
export function assertEntityLifecycleContext(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("entity lifecycle context must be an object");
    }
    const candidate = value;
    if (!isEntityKind(candidate.kind))
        throw new TypeError(`unknown lifecycle context kind: ${String(candidate.kind)}`);
    assertEntityState(candidate.state, "lifecycle context state");
    if (typeof candidate.version !== "number" || !Number.isSafeInteger(candidate.version) || candidate.version < 0) {
        throw new TypeError("lifecycle context version must be a non-negative safe integer");
    }
    if (typeof candidate.now !== "string" || candidate.now.trim() === "") {
        throw new TypeError("lifecycle context now must be a non-empty string");
    }
}
function normalizeHooks(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const source = value;
    const normalized = {};
    for (const event of ENTITY_LIFECYCLE_EVENTS) {
        const callback = source[event];
        if (callback === undefined)
            continue;
        if (typeof callback !== "function")
            throw new TypeError(`${label} ${event} must be a function`);
        normalized[event] = callback;
    }
    return Object.freeze(normalized);
}
function asLifecycleError(error) {
    if (error instanceof Error)
        return error;
    return new TypeError(`lifecycle callback threw a non-Error value: ${String(error)}`);
}
function emptyDispatchResult() {
    return Object.freeze({ invoked: 0, errors: Object.freeze([]) });
}
/**
 * Creates a dispatcher over zero or more callback objects. A single callback
 * object and an array of them are both accepted; `register` can append more.
 * `pre*` failures abort the call immediately, while `post*` failures are
 * collected so independent cleanup callbacks still run.
 */
export function createLifecycleDispatcher(hooks) {
    const registered = [];
    const dispatcher = {
        register(value) {
            registered.push(normalizeHooks(value, "lifecycle hooks"));
            return dispatcher;
        },
        fire(event, entity, context) {
            assertLifecycleEvent(event);
            assertEntityLifecycleContext(context);
            let invoked = 0;
            const errors = [];
            for (const hook of registered) {
                const callback = hook[event];
                if (callback === undefined)
                    continue;
                invoked += 1;
                try {
                    callback(entity, context);
                }
                catch (error) {
                    if (event.startsWith("pre"))
                        throw error;
                    errors.push(asLifecycleError(error));
                }
            }
            return Object.freeze({ invoked, errors: Object.freeze(errors) });
        },
    };
    if (hooks !== undefined) {
        const values = Array.isArray(hooks)
            ? hooks
            : [hooks];
        for (const hook of values)
            dispatcher.register(hook);
    }
    return Object.freeze(dispatcher);
}
/**
 * Registry of lifecycle callbacks per `EntityKind`. One callback object may be
 * registered per kind; registering twice is rejected so a kind's callbacks stay
 * predictable. Firing a kind that has no registered callbacks is a no-op.
 */
export class LifecycleRegistry {
    hooks = new Map();
    dispatchers = new Map();
    constructor(initial) {
        if (initial === undefined)
            return;
        if (typeof initial !== "object" || initial === null || Array.isArray(initial)) {
            throw new TypeError("lifecycle registry initial hooks must be an object");
        }
        for (const [kind, hooks] of Object.entries(initial)) {
            if (hooks === undefined)
                continue;
            this.register(kind, hooks);
        }
    }
    register(kind, hooks) {
        if (!isEntityKind(kind))
            throw new TypeError(`unknown entity kind: ${String(kind)}`);
        if (this.hooks.has(kind))
            throw new TypeError(`lifecycle hooks are already registered for: ${kind}`);
        const normalized = normalizeHooks(hooks, `lifecycle hooks for ${kind}`);
        this.hooks.set(kind, normalized);
        this.dispatchers.set(kind, createLifecycleDispatcher(normalized));
        return this;
    }
    has(kind) {
        return this.hooks.has(kind);
    }
    get(kind) {
        return this.hooks.get(kind);
    }
    /** Registered kinds in registration order. */
    kinds() {
        return Object.freeze([...this.hooks.keys()]);
    }
    fire(kind, event, entity, context) {
        if (!isEntityKind(kind))
            throw new TypeError(`unknown entity kind: ${String(kind)}`);
        assertLifecycleEvent(event);
        assertEntityLifecycleContext(context);
        if (context.kind !== kind) {
            throw new TypeError(`lifecycle context kind ${context.kind} does not match ${kind}`);
        }
        const dispatcher = this.dispatchers.get(kind);
        if (dispatcher === undefined)
            return emptyDispatchResult();
        return dispatcher.fire(event, entity, context);
    }
}
