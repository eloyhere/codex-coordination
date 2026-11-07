# Exact reference AMP SQLite stack

The SQLite implementation is copied from the installed `attention-manifest-protocol` **0.7.1** in `R:/project/deepseek-coordination/node_modules/attention-manifest-protocol`. The host continues to depend on AMP **0.7.5** for kernel, agent, persistence, workflow, budget, policy, and all other upper domains. No dependency downgrade implements this transplant.

## Copied source and integrity

The five requested directories are copied completely, including JavaScript and declaration files:

- `vendor/amp-sqlite/lib/entity`
- `vendor/amp-sqlite/lib/cache`
- `vendor/amp-sqlite/lib/service`
- `vendor/amp-sqlite/lib/repository`
- `vendor/amp-sqlite/lib/sql`

`connection` and `serialization` are the minimal additional AMP directories required by those runtime imports and declarations. Their relative imports remain unchanged. The closure contains 64 library files plus the original package manifest, LICENSE and NOTICE: **67 files, 224,654 bytes**. `vendor/amp-sqlite/SNAPSHOT.json` records every copied file's byte length and SHA-256. No copied file was edited, reformatted or generated again. Any adaptation belongs outside that directory. The build verifies the entire snapshot before compiling and fails on a changed byte.

The reference/current comparison found identical files in entity, cache, service, sql, and connection. Only `sqliteEvents.js` and `sqliteRepository.js` differ in repository. Reference serialization is retained because its repository calls `safeStringify(payload)`; current 0.7.5 repositories explicitly opt into `filterShared: true`, and the current serializer has different defaults. Copying only repository would therefore silently change the reference behavior. Upper native AMP serialization remains 0.7.5 and is not redirected.

The copied package manifest is provenance metadata, not an installed replacement package or an independently buildable complete AMP package. Its external runtime dependency `semantic-typescript` resolves from the existing locked dependency graph; Node 24 supplies `node:sqlite`. The copied manifest's unrelated optional upper domains are not transplanted.

## Actual runtime integration

`scripts/amp-sqlite-resolver.mjs` resolves direct AMP package imports and transitive relative imports from installed AMP modules. It maps entity, cache, service, repository, sql and connection to canonical absolute paths inside the copied closure. The copied modules use their original relative imports, including the copied serialization support. Installed upper modules keep their original paths.

`src/mcp/amp/storage.mts` exposes the Store service and storage namespaces through re-exports. `native-store.mts` imports this façade. `scripts/build.mjs` installs the resolver for both its runtime preparation stage and final server compilation. The final compilation uses ESM splitting across all entrypoints, so native kernel imports, direct service imports and the façade share one Store implementation, module identity table, and path-indexed connection pool. The façade alone would not guarantee that property if every entry were bundled independently.

The existing external imports between local `.mjs` entrypoints remain external. Generated shared chunks are emitted inside the MCP payload and are included by the existing recursive plugin package rule. Bundles retain their legal comments; server assets include the reference LICENSE/NOTICE in THIRD_PARTY_LICENSES and a copy of AMP_SQLITE_SNAPSHOT. No production adapter logic is placed inside copied files.

## Database compatibility and boundaries

Both source stacks use the same core SQLite schema migration **1**, the same JSON entity row table and append-only event schema, and the same entity descriptors. This change adds no database migration and never deletes or rebuilds existing databases. Opening a database applies the reference's existing idempotent migration/index setup. Existing ordinary 0.7.5 entity/event JSON round-trips through the copied stack; a regression confirms that reading an existing row and adding another row leaves the original payload text unchanged.

Compatibility is limited to the supported schema and payload contracts. Unknown custom schemas, malformed JSON, and databases from unrelated legacy storage implementations are not converted. Cycles and repeated shared references follow the reference serializer's filter-once semantics; that is a property of the requested exact copy. It does not promise a lossless graph encoding.

Repository session/tenant filters operate on the persisted `session_id` and `tenant_id` columns. They do not infer nested payload scopes such as `attention.scope.sessionId`. A domain whose descriptors leave those columns null must continue filtering its payload at the outside adapter boundary.

The reference implementation has these shared upstream behavioral limits, retained to preserve exact bytes:

- Explicit `save(entityWithNextVersion, { expectedVersion })` performs SQLite CAS, including rejecting a nonzero expected version when a row is absent. Direct proxy property writes persist immediately, but `jsonDescriptor.decode` returns the payload unchanged, so the proxy commit's synthesized record version does not automatically update a version field inside that payload. Callers requiring version progression use explicit versioned saves.
- Multiple Store instances for one database share the same managed proxy and connection. Their transaction context is instance-local. Nested transactions on the same Store use savepoints and roll back correctly; starting a second Store's transaction while the first owns an active transaction is rejected with `connection already has an active transaction`. Pass the same Store through one operation's transaction chain.
- Managed identities synchronize writes made through their live owner. Repository caches are Store-local, and the unmodified Store does not provide general cross-process invalidation. `refresh` clears caches of the registered identity owners before reading durable state. The copy is not extended with a new cross-process cache protocol.

## Regression verification

Run `node --test test/amp-sqlite-stack.test.mjs`. It compiles two isolated temporary entrypoints with the production resolver and ESM splitting, without rebuilding plugin outputs. It verifies:

1. Every copied hash; native upper kernel and serialization remain native; only the copied six storage directories enter the compiled graph; Store contributes to one shared output.
2. Façade/direct native service constructor identity, native kernel `instanceof Store`, shared connection and managed proxy identity, and keeping another owner usable when one Store closes.
3. Shared managed-state visibility, explicit stale/missing-row CAS rejection, nested savepoint and event rollback, rejection of a second owner's nested transaction, commit/reopen, and session-column filters.
4. Cache namespace invalidation across service proxies sharing one entity cache.
5. Native 0.7.5 Session → Turn → Intent → Mission → Goal → Plan → Task → Action, budget reservation/settlement, workflow reconstruction and budget restoration through the copied schema.
6. Opening an ordinary 0.7.5 SQLite database with the copied implementation without rewriting existing payloads or removing rows.

The test deletes only its newly created random temporary directory. Existing workspace databases are never deleted for verification.
