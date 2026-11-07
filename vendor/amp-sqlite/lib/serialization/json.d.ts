import type { DigestOf, SafeParse, SafeStringify } from "./types.js";
/**
 * Serialize `value` to JSON text without throwing a raw `TypeError` for cycles
 * (they never reach the native serializer) or for hostile values.
 */
export declare const safeStringify: SafeStringify;
/**
 * Parse external or previously persisted JSON text. A malformed document,
 * including one that throws from a reviver extension point, becomes a
 * `SerializationError`; no partially built value escapes.
 */
export declare const safeParse: SafeParse;
/**
 * Content digest of a value: stable (key-sorted) JSON text hashed with SHA-256.
 * The `sha256:` prefix matches the convention already used by the protocol's
 * context, session and execution digests. Equal values produce equal digests
 * regardless of property insertion order; cycles and shared references are
 * filtered by the library semantics described above.
 */
export declare const digestOf: DigestOf;
