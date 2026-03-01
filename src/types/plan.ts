/**
 * @fileoverview Plan orchestrator type definitions
 */

/** Task execution status for plan tracking */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

/** TDD phase categories */
export type TddPhase = 'setup' | 'test' | 'impl' | 'verify' | 'review';

/** Development phase in TDD cycle (alias for TddPhase) */
export type PlanPhase = TddPhase;

/**
 * A single plan item for plan orchestration.
 * Moved here from plan-orchestrator.ts to break circular dependency.
 */
export interface PlanItem {
  id?: string;
  content: string;
  priority: 'P0' | 'P1' | 'P2' | null;
  source?: string;
  rationale?: string;
  verificationCriteria?: string;
  testCommand?: string;
  dependencies?: string[];
  status?: PlanTaskStatus;
  attempts?: number;
  lastError?: string;
  completedAt?: number;
  complexity?: 'low' | 'medium' | 'high';
  tddPhase?: PlanPhase;
  pairedWith?: string;
  reviewChecklist?: string[];
}
