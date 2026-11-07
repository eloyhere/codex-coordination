import { safeParse, safeStringify } from "../serialization/index.js";
function serializePayload(payload) {
    return safeStringify(payload);
}
function parsePayload(value) {
    if (typeof value !== "string")
        throw new TypeError("events.payload must be a string");
    // Persisted payloads are external input: a malformed row must fail as a
    // SerializationError rather than yield a half-decoded value.
    return safeParse(value);
}
function sequenceOf(value) {
    return typeof value === "bigint" ? Number(value) : value;
}
/** Appends one event and returns it with the database-assigned sequence. */
export function appendEvent(driver, event) {
    const result = driver.run({
        sql: "INSERT INTO events (kind, entity_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
        parameters: [event.kind, event.entityId ?? null, event.recordedAt, serializePayload(event.payload)],
    });
    return {
        sequence: sequenceOf(result.lastInsertRowid),
        kind: event.kind,
        ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
        recordedAt: event.recordedAt,
        payload: event.payload,
    };
}
/** Reads events in append order, optionally narrowed by kind and limit. */
export function readEvents(driver, options = {}) {
    const clauses = [];
    const parameters = [];
    if (options.kind !== undefined) {
        clauses.push("kind = ?");
        parameters.push(options.kind);
    }
    let limit = "";
    if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 0)
            throw new RangeError("limit must be a non-negative safe integer");
        limit = " LIMIT ?";
        parameters.push(options.limit);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = driver.query({
        sql: `SELECT sequence, kind, entity_id, recorded_at, payload FROM events${where} ORDER BY sequence ASC${limit}`,
        parameters,
    });
    return rows.map((row) => ({
        sequence: sequenceOf(row.sequence),
        kind: row.kind,
        ...(typeof row.entity_id === "string" ? { entityId: row.entity_id } : {}),
        recordedAt: row.recorded_at,
        payload: parsePayload(row.payload),
    }));
}
