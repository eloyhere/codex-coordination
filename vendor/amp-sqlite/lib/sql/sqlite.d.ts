import type { SqlDriver, SqliteOptions } from "./types.js";
/**
 * Opens a synchronous SQLite driver over `node:sqlite`.
 *
 * The connection runs with foreign-key enforcement by default and file-backed
 * databases switch to WAL unless disabled. In-memory databases and read-only
 * connections cannot change the journal mode and therefore skip that pragma.
 */
export declare function openSqlite(options: SqliteOptions): SqlDriver;
