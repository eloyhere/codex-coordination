/**
 * Shared contracts for the serialization helpers.
 *
 * Everything exported at runtime from `src/serialization` is frozen and pure:
 * the functions read their arguments, keep no module-level mutable state and
 * never mutate the value they are given. `safeStringify`/`digestOf` always
 * return a string or throw `SerializationError`; no partial result escapes.
 */
export {};
