import type { SchemaMigration, SqlDriver } from "./types.js";
/**
 * The baseline schema of the entity/event store. Every statement is
 * idempotent so a partially prepared database is safe to migrate again.
 */
export declare const CORE_MIGRATIONS: readonly SchemaMigration[];
/** Current recorded schema version; `0` when the database has no migration table yet. */
export declare function schemaVersion(driver: SqlDriver): number;
/**
 * Applies every migration newer than the recorded schema version, each inside
 * its own writer transaction. Re-running with the same input is a no-op and
 * returns the current version.
 */
export declare function migrate(driver: SqlDriver, migrations?: readonly SchemaMigration[]): number;
