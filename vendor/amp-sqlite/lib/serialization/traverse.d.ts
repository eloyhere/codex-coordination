import type { TraverseStats, TraverseVisitor } from "./types.js";
/**
 * Traverse `root` without following circular/shared references twice and
 * return frozen statistics. A non-object root is not traversable (matching
 * `useTraverse`) and yields zero counts.
 */
export declare const traverseSafely: (root: unknown, visitor: TraverseVisitor) => TraverseStats;
