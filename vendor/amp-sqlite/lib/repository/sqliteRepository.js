import { safeParse, safeStringify } from "../serialization/index.js";
const SELECT_COLUMNS = "kind, id, tenant_id, session_id, version, updated_at, payload";
function toNumber(value) {
    return typeof value === "bigint" ? Number(value) : value;
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function serializePayload(payload) {
    return safeStringify(payload);
}
function parsePayload(value) {
    if (typeof value !== "string")
        throw new TypeError("entities.payload must be a string");
    // Persisted payloads are external input; malformed rows fail atomically.
    return safeParse(value);
}
function recordOf(row) {
    const tenantId = optionalString(row.tenant_id);
    const sessionId = optionalString(row.session_id);
    return {
        id: row.id,
        kind: row.kind,
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        version: toNumber(row.version),
        updatedAt: row.updated_at,
        payload: parsePayload(row.payload),
    };
}
function cacheKey(kind, id) {
    return `${kind}:${id}`;
}
function filterSql(kind, context, filter) {
    const clauses = ["kind = ?"];
    const parameters = [filter.kind ?? kind];
    const tenantId = filter.tenantId ?? context.tenantId;
    if (tenantId !== undefined) {
        clauses.push("tenant_id = ?");
        parameters.push(tenantId);
    }
    if (filter.sessionId !== undefined) {
        clauses.push("session_id = ?");
        parameters.push(filter.sessionId);
    }
    return { clause: ` WHERE ${clauses.join(" AND ")}`, parameters };
}
function limitSql(limit) {
    if (limit === undefined)
        return { clause: "", parameters: [] };
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new RangeError("limit must be a non-negative safe integer");
    return { clause: " LIMIT ?", parameters: [limit] };
}
/**
 * Creates the SQLite-backed repository for one entity descriptor.
 *
 * Reads use the supplied cache as a read-through layer. Writes persist the
 * descriptor's encoded record, invalidate the cached aggregate and store the
 * written aggregate back into the cache. When the context carries a tenant and
 * the filter/record omits one, the context tenant becomes the default scope.
 */
export function createSqliteRepository(descriptor, context) {
    function get(id) {
        const key = cacheKey(descriptor.kind, id);
        const now = context.now();
        const cached = context.cache.get(key, now);
        if (cached !== undefined)
            return cached;
        const rows = context.driver.query({
            sql: `SELECT ${SELECT_COLUMNS} FROM entities WHERE kind = ? AND id = ?`,
            parameters: [descriptor.kind, id],
        });
        const row = rows[0];
        if (row === undefined)
            return undefined;
        const entity = descriptor.decode(recordOf(row));
        context.cache.set(key, entity, now);
        return entity;
    }
    function put(entity, options = {}) {
        const record = descriptor.encode(entity);
        const key = cacheKey(descriptor.kind, record.id);
        const parameters = [
            descriptor.kind,
            record.id,
            record.tenantId ?? context.tenantId ?? null,
            record.sessionId ?? null,
            record.version,
            record.updatedAt,
            serializePayload(record.payload),
        ];
        const baseSql = `INSERT INTO entities (kind, id, tenant_id, session_id, version, updated_at, payload)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(kind, id) DO UPDATE SET
    tenant_id = excluded.tenant_id,
    session_id = excluded.session_id,
    version = excluded.version,
    updated_at = excluded.updated_at,
    payload = excluded.payload`;
        let sql = baseSql;
        if (options.expectedVersion !== undefined) {
            if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0) {
                throw new RangeError("expectedVersion must be a non-negative safe integer");
            }
            // A missing row has version zero; nonzero expectations may only update an existing row.
            sql = `INSERT INTO entities (kind, id, tenant_id, session_id, version, updated_at, payload)
SELECT ?, ?, ?, ?, ?, ?, ?
WHERE ? = 0 OR EXISTS (SELECT 1 FROM entities WHERE kind = ? AND id = ? AND version = ?)
ON CONFLICT(kind, id) DO UPDATE SET
    tenant_id = excluded.tenant_id,
    session_id = excluded.session_id,
    version = excluded.version,
    updated_at = excluded.updated_at,
    payload = excluded.payload WHERE entities.version = ?`;
            parameters.push(options.expectedVersion, descriptor.kind, record.id, options.expectedVersion, options.expectedVersion);
        }
        const result = context.driver.run({ sql, parameters });
        if (options.expectedVersion !== undefined && result.changes === 0)
            throw new Error("version_conflict");
        const now = context.now();
        context.cache.delete(key);
        context.cache.set(key, entity, now);
        return entity;
    }
    function remove(id) {
        const key = cacheKey(descriptor.kind, id);
        const result = context.driver.run({
            sql: "DELETE FROM entities WHERE kind = ? AND id = ?",
            parameters: [descriptor.kind, id],
        });
        context.cache.delete(key);
        return result.changes > 0;
    }
    function list(filter = {}) {
        const filterClause = filterSql(descriptor.kind, context, filter);
        const limit = limitSql(filter.limit);
        const rows = context.driver.query({
            sql: `SELECT ${SELECT_COLUMNS} FROM entities${filterClause.clause} ORDER BY updated_at DESC, id ASC${limit.clause}`,
            parameters: [...filterClause.parameters, ...limit.parameters],
        });
        return rows.map((row) => descriptor.decode(recordOf(row)));
    }
    function count(filter = {}) {
        const filterClause = filterSql(descriptor.kind, context, filter);
        const rows = context.driver.query({
            sql: `SELECT COUNT(*) AS count FROM entities${filterClause.clause}`,
            parameters: filterClause.parameters,
        });
        const value = rows[0]?.count ?? 0;
        return toNumber(value);
    }
    return { get, put, delete: remove, list, count };
}
