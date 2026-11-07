/**
 * Concrete declarations for every `EntityKind`.
 *
 * All aggregates share the JSON row table used by the repository layer. Each
 * declaration names its key, columns, indexes, associations and lifecycle
 * guards; `registry.ts` only projects this map into the public registry.
 */
import { LifecycleRegistry } from "./lifecycle.js";
import type { EntityLifecycle } from "./lifecycle.js";
import type { Entity, EntityKind } from "./types.js";
/** One optional hook object per declared kind. */
export declare const ENTITY_LIFECYCLES: Readonly<Record<EntityKind, EntityLifecycle<unknown>>>;
/** Registry pre-populated with {@link ENTITY_LIFECYCLES}. */
export declare const ENTITY_LIFECYCLE_REGISTRY: LifecycleRegistry;
/** Returns the declared lifecycle hooks for one kind. */
export declare function lifecycleFor(kind: EntityKind): EntityLifecycle<unknown>;
/** Entity metadata plus the optional callbacks declared for it. */
export interface DeclaredEntity<T = unknown> extends Entity<T> {
    readonly lifecycle: EntityLifecycle<T>;
}
export declare const SessionEntity: DeclaredEntity;
export declare const TurnEntity: DeclaredEntity;
export declare const IntentEntity: DeclaredEntity;
export declare const MissionEntity: DeclaredEntity;
export declare const GoalEntity: DeclaredEntity;
export declare const PlanEntity: DeclaredEntity;
export declare const TaskEntity: DeclaredEntity;
export declare const ActionEntity: DeclaredEntity;
/**
 * One execution attempt joined to its action. The domain identifier is
 * `attemptId`; attempts carry `version` (0 while running, 1 once settled) and
 * are keyed by it like every other aggregate.
 */
export declare const ActionAttemptEntity: DeclaredEntity;
export declare const EvidenceEntity: DeclaredEntity;
export declare const ReceiptEntity: DeclaredEntity;
export declare const ReceiptIntegrityEntity: DeclaredEntity;
export declare const VerificationEntity: DeclaredEntity;
export declare const ProvenanceEventEntity: DeclaredEntity;
export declare const EvidenceAuditEntity: DeclaredEntity;
export declare const AttentionEntity: DeclaredEntity;
export declare const ProjectRuleEntity: DeclaredEntity;
export declare const ProjectMetadataEntity: DeclaredEntity;
export declare const ProjectViewEntity: DeclaredEntity;
export declare const ProjectEnvironmentEntity: DeclaredEntity;
export declare const BudgetLedgerEntity: DeclaredEntity;
export declare const BudgetReservationEntity: DeclaredEntity;
export declare const ManifestEntity: DeclaredEntity;
export declare const CapabilityActivationEntity: DeclaredEntity;
export declare const ExecutionInvocationEntity: DeclaredEntity;
export declare const ExecutionObservationEntity: DeclaredEntity;
export declare const CooperationTaskEntity: DeclaredEntity;
export declare const CooperationMessageEntity: DeclaredEntity;
export declare const BehaviorCandidateEntity: DeclaredEntity;
export declare const ContextCheckpointEntity: DeclaredEntity;
export declare const ContextCacheEntryEntity: DeclaredEntity;
export declare const StoreMetaEntity: DeclaredEntity;
/** Complete declaration map; the registry is a frozen projection of this. */
export declare const ENTITY_DECLARATIONS: Readonly<Record<EntityKind, DeclaredEntity>>;
