/**
 * Concrete declarations for every `EntityKind`.
 *
 * All aggregates share the JSON row table used by the repository layer. Each
 * declaration names its key, columns, indexes, associations and lifecycle
 * guards; `registry.ts` only projects this map into the public registry.
 */
import { cascade, manyToMany, manyToOne, oneToMany } from "./associate.js";
import { column, entity, index, jsonDescriptor } from "./entity.js";
import { ENTITY_KINDS, compositeId, id, isEntityKind, keyOf } from "./key.js";
import { LifecycleRegistry } from "./lifecycle.js";
const TABLE = "entities";
function textField(value, property) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const field = value[property];
    return typeof field === "string" && field.trim() !== "" ? field : undefined;
}
function versionField(kind, entity) {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity))
        return 0;
    const value = entity.version;
    if (value === undefined)
        return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`entity ${kind} version must be a non-negative safe integer`);
    }
    return value;
}
/**
 * Builds the descriptor used by the JSON row table. The declared key is always
 * `id` (or `key` for store_meta); `legacyKey` lets descriptors keep addressing
 * aggregates whose domain object still names its identifier `budgetKey`,
 * `manifestId`, `signature`, or a composite of project coordinates.
 */
function descriptorFor(kind, legacyKey) {
    if (legacyKey === undefined)
        return undefined;
    return jsonDescriptor(kind, {
        table: TABLE,
        idOf: (entity) => textField(entity, "id") ?? keyOf(legacyKey, entity),
        tenantOf: entity => textField(entity, "tenantId"),
        sessionOf: entity => textField(entity, "sessionId"),
        kindOf: entity => textField(entity, "kind"),
        versionOf: entity => versionField(kind, entity),
        updatedAtOf: entity => textField(entity, "updatedAt") ?? textField(entity, "createdAt") ?? new Date().toISOString(),
    });
}
function declaration(options) {
    const key = options.key ?? id();
    const keyProperty = key.properties[0] ?? "id";
    const keyColumn = key.columns[0] ?? keyProperty;
    const columns = [
        column(keyProperty, { column: keyColumn, nullable: false, unique: true }),
        column("tenantId", { nullable: options.tenantNullable ?? true }),
        column("sessionId", { nullable: options.sessionNullable ?? true }),
        column("kind", { nullable: options.kindNullable ?? true }),
        column("version", { nullable: false, version: true }),
        column("updatedAt", { nullable: false }),
        column("payload", { nullable: false }),
    ];
    const descriptor = descriptorFor(options.kind, options.legacyKey);
    return entity({
        kind: options.kind,
        table: TABLE,
        access: "field",
        key,
        columns,
        indexes: [
            index(`idx_${options.kind}_tenant`, ["tenant_id"]),
            index(`idx_${options.kind}_session`, ["session_id"]),
            index(`idx_${options.kind}_updated`, ["updated_at"]),
        ],
        associations: options.associations ?? [],
        versionColumn: "version",
        ...(descriptor === undefined ? {} : { descriptor }),
    });
}
/* ------------------------------------------------------------------ */
/* Lifecycle hooks                                                    */
/* ------------------------------------------------------------------ */
function requireRecord(entity, label) {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity)) {
        throw new TypeError(`${label} must be an object`);
    }
    return entity;
}
function assertIdentity(kind, idProperty, event, entity) {
    const record = requireRecord(entity, `${kind} ${event} entity`);
    const value = record[idProperty];
    if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${kind} ${event} requires a non-empty ${idProperty}`);
    }
}
function assertVersion(kind, event, entity, context) {
    const candidate = requireRecord(entity, `${kind} ${event} entity`).version;
    const version = candidate === undefined ? context.version : candidate;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new TypeError(`${kind} ${event} requires a non-negative safe integer version`);
    }
}
function freezeLoaded(kind, entity) {
    if (typeof entity !== "object" || entity === null) {
        throw new TypeError(`${kind} postLoad entity must be an object`);
    }
    // Freezing is idempotent, so repeated `postLoad` calls are safe.
    if (!Object.isFrozen(entity))
        Object.freeze(entity);
}
function createLifecycle(kind) {
    const idProperty = kind === "store_meta" ? "key" : "id";
    return Object.freeze({
        prePersist(entity, context) {
            assertIdentity(kind, idProperty, "prePersist", entity);
            assertVersion(kind, "prePersist", entity, context);
        },
        preUpdate(entity, context) {
            assertIdentity(kind, idProperty, "preUpdate", entity);
            assertVersion(kind, "preUpdate", entity, context);
        },
        preRemove(entity) {
            assertIdentity(kind, idProperty, "preRemove", entity);
        },
        postLoad(entity) {
            freezeLoaded(kind, entity);
        },
    });
}
/** One optional hook object per declared kind. */
export const ENTITY_LIFECYCLES = Object.freeze(Object.fromEntries(ENTITY_KINDS.map(kind => [kind, createLifecycle(kind)])));
/** Registry pre-populated with {@link ENTITY_LIFECYCLES}. */
export const ENTITY_LIFECYCLE_REGISTRY = new LifecycleRegistry(ENTITY_LIFECYCLES);
/** Returns the declared lifecycle hooks for one kind. */
export function lifecycleFor(kind) {
    if (!isEntityKind(kind))
        throw new TypeError(`unknown entity kind: ${String(kind)}`);
    return ENTITY_LIFECYCLES[kind];
}
function declare(options) {
    const metadata = declaration(options);
    return Object.freeze({
        ...metadata,
        lifecycle: ENTITY_LIFECYCLES[options.kind],
    });
}
/* ------------------------------------------------------------------ */
/* Interaction: session -> turn -> intent -> mission -> goal -> ...   */
/* ------------------------------------------------------------------ */
export const SessionEntity = declare({
    kind: "session",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        oneToMany("turns", "turn", {
            mappedBy: "session",
            joinProperty: "sessionId",
            cascade: cascade("persist", "remove"),
        }),
    ],
});
export const TurnEntity = declare({
    kind: "turn",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("session", "session", { targetProperty: "id", optional: false }),
        oneToMany("intents", "intent", { mappedBy: "originTurn" }),
    ],
});
export const IntentEntity = declare({
    kind: "intent",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("originTurn", "turn", { targetProperty: "id", optional: false }),
        oneToMany("missions", "mission", { mappedBy: "intent" }),
    ],
});
export const MissionEntity = declare({
    kind: "mission",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("intent", "intent", { targetProperty: "id", optional: false }),
        oneToMany("goals", "goal", { mappedBy: "mission" }),
    ],
});
export const GoalEntity = declare({
    kind: "goal",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("mission", "mission", { targetProperty: "id", optional: false }),
        oneToMany("plans", "plan", { mappedBy: "goal" }),
        // Goal dependencies are a true n:m edge owned by this side; the join
        // table makes the owning side explicit.
        manyToMany("dependencies", "goal", {
            joinTable: "goal_dependencies",
            joinColumns: ["goal_id"],
            inverseJoinColumns: ["dependency_id"],
            cascade: cascade("persist"),
        }),
    ],
});
export const PlanEntity = declare({
    kind: "plan",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("goal", "goal", { targetProperty: "id", optional: false }),
        oneToMany("tasks", "task", {
            mappedBy: "plan",
            joinProperty: "planId",
            cascade: cascade("persist", "remove"),
        }),
    ],
});
export const TaskEntity = declare({
    kind: "task",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("plan", "plan", { targetProperty: "id", optional: false }),
        oneToMany("actions", "action", {
            mappedBy: "task",
            joinProperty: "taskId",
            cascade: cascade("persist", "remove"),
        }),
    ],
});
export const ActionEntity = declare({
    kind: "action",
    sessionNullable: false,
    kindNullable: false,
    associations: [manyToOne("task", "task", { targetProperty: "id", optional: false })],
});
/**
 * One execution attempt joined to its action. The domain identifier is
 * `attemptId`; attempts carry `version` (0 while running, 1 once settled) and
 * are keyed by it like every other aggregate.
 */
export const ActionAttemptEntity = declare({
    kind: "action_attempt",
    sessionNullable: false,
    legacyKey: id("attemptId"),
    associations: [manyToOne("action", "action", { targetProperty: "id", optional: false })],
});
/* ------------------------------------------------------------------ */
/* Evidence and receipts                                              */
/* ------------------------------------------------------------------ */
export const EvidenceEntity = declare({
    kind: "evidence",
    tenantNullable: false,
    associations: [manyToOne("receipt", "receipt", { targetProperty: "id", optional: false })],
});
export const ReceiptEntity = declare({
    kind: "receipt",
    associations: [oneToMany("evidence", "evidence", { mappedBy: "receipt" })],
});
export const ReceiptIntegrityEntity = declare({ kind: "receipt_integrity" });
export const VerificationEntity = declare({ kind: "verification" });
export const ProvenanceEventEntity = declare({ kind: "provenance_event" });
export const EvidenceAuditEntity = declare({ kind: "evidence_audit" });
/* ------------------------------------------------------------------ */
/* Attention                                                          */
/* ------------------------------------------------------------------ */
export const AttentionEntity = declare({
    kind: "attention",
    tenantNullable: false,
});
/* ------------------------------------------------------------------ */
/* Project                                                            */
/* ------------------------------------------------------------------ */
export const ProjectRuleEntity = declare({
    kind: "project_rule",
    tenantNullable: false,
    associations: [
        oneToMany("metadata", "project_metadata", { mappedBy: "projectRule" }),
        oneToMany("views", "project_view", { mappedBy: "projectRule" }),
    ],
});
export const ProjectMetadataEntity = declare({
    kind: "project_metadata",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId", "path"]),
    associations: [manyToOne("projectRule", "project_rule", { targetProperty: "id" })],
});
export const ProjectViewEntity = declare({
    kind: "project_view",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId", "kind"]),
    associations: [manyToOne("projectRule", "project_rule", { targetProperty: "id" })],
});
export const ProjectEnvironmentEntity = declare({
    kind: "project_environment",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId"]),
});
/* ------------------------------------------------------------------ */
/* Budget and governance                                              */
/* ------------------------------------------------------------------ */
export const BudgetLedgerEntity = declare({
    kind: "budget_ledger",
    tenantNullable: false,
    legacyKey: id("budgetKey"),
    associations: [
        oneToMany("reservations", "budget_reservation", {
            mappedBy: "ledger",
            joinProperty: "budgetKey",
            cascade: cascade("persist"),
            orphanRemoval: true,
        }),
    ],
});
export const BudgetReservationEntity = declare({
    kind: "budget_reservation",
    tenantNullable: false,
    associations: [manyToOne("ledger", "budget_ledger", { targetProperty: "id" })],
});
export const ManifestEntity = declare({
    kind: "manifest",
    tenantNullable: false,
    legacyKey: id("manifestId"),
});
export const CapabilityActivationEntity = declare({
    kind: "capability_activation",
    legacyKey: id("activationId"),
});
/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */
export const ExecutionInvocationEntity = declare({
    kind: "execution_invocation",
    tenantNullable: false,
    associations: [oneToMany("observations", "execution_observation", { mappedBy: "invocation" })],
});
export const ExecutionObservationEntity = declare({
    kind: "execution_observation",
    tenantNullable: false,
    associations: [manyToOne("invocation", "execution_invocation", { targetProperty: "id" })],
});
/* ------------------------------------------------------------------ */
/* Cooperation                                                        */
/* ------------------------------------------------------------------ */
export const CooperationTaskEntity = declare({
    kind: "cooperation_task",
    tenantNullable: false,
    legacyKey: id("taskId"),
    associations: [oneToMany("messages", "cooperation_message", { mappedBy: "task" })],
});
export const CooperationMessageEntity = declare({
    kind: "cooperation_message",
    tenantNullable: false,
    legacyKey: id("messageId"),
    associations: [manyToOne("task", "cooperation_task", { targetProperty: "id" })],
});
/* ------------------------------------------------------------------ */
/* Behaviour and context                                              */
/* ------------------------------------------------------------------ */
export const BehaviorCandidateEntity = declare({
    kind: "behavior_candidate",
    legacyKey: id("candidateId"),
});
export const ContextCheckpointEntity = declare({
    kind: "context_checkpoint",
    tenantNullable: false,
    associations: [
        oneToMany("cacheEntries", "context_cache_entry", {
            mappedBy: "checkpoint",
            joinProperty: "checkpointId",
            cascade: cascade("persist"),
            orphanRemoval: true,
        }),
    ],
});
export const ContextCacheEntryEntity = declare({
    kind: "context_cache_entry",
    tenantNullable: false,
    legacyKey: id("signature"),
    associations: [manyToOne("checkpoint", "context_checkpoint", { targetProperty: "id" })],
});
/* ------------------------------------------------------------------ */
/* Store metadata                                                     */
/* ------------------------------------------------------------------ */
export const StoreMetaEntity = declare({
    kind: "store_meta",
    key: id("key"),
});
/** Complete declaration map; the registry is a frozen projection of this. */
export const ENTITY_DECLARATIONS = Object.freeze({
    session: SessionEntity,
    turn: TurnEntity,
    intent: IntentEntity,
    mission: MissionEntity,
    goal: GoalEntity,
    plan: PlanEntity,
    task: TaskEntity,
    action: ActionEntity,
    action_attempt: ActionAttemptEntity,
    evidence: EvidenceEntity,
    receipt: ReceiptEntity,
    receipt_integrity: ReceiptIntegrityEntity,
    verification: VerificationEntity,
    provenance_event: ProvenanceEventEntity,
    evidence_audit: EvidenceAuditEntity,
    attention: AttentionEntity,
    project_rule: ProjectRuleEntity,
    project_metadata: ProjectMetadataEntity,
    project_view: ProjectViewEntity,
    project_environment: ProjectEnvironmentEntity,
    budget_ledger: BudgetLedgerEntity,
    budget_reservation: BudgetReservationEntity,
    manifest: ManifestEntity,
    capability_activation: CapabilityActivationEntity,
    execution_invocation: ExecutionInvocationEntity,
    execution_observation: ExecutionObservationEntity,
    cooperation_task: CooperationTaskEntity,
    cooperation_message: CooperationMessageEntity,
    behavior_candidate: BehaviorCandidateEntity,
    context_checkpoint: ContextCheckpointEntity,
    context_cache_entry: ContextCacheEntryEntity,
    store_meta: StoreMetaEntity,
});
