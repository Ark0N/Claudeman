/**
 * Planner Prompt - Single agent for TDD plan generation
 *
 * Combines what was previously 5 separate agents:
 * - Requirements Analyst (redundant)
 * - Architecture Planner (redundant)
 * - Testing Specialist (kept - TDD focus)
 * - Risk Analyst (redundant)
 * - Verification Expert (kept - structure)
 *
 * Placeholders: {TASK}, {RESEARCH_CONTEXT}
 */

export const PLANNER_PROMPT = `You are a TDD Plan Generator. Create a complete implementation plan with test-first approach.

## TASK DESCRIPTION
{TASK}

{RESEARCH_CONTEXT}

## YOUR MISSION
Generate a complete TDD implementation plan with:
1. Tests BEFORE implementations (red-green-refactor)
2. Review tasks AFTER implementations
3. Clear priorities (P0=blocking, P1=required, P2=polish)
4. Dependencies between tasks

## TDD CYCLE
For each feature:
1. Write failing test first
2. Implement to make test pass
3. Review implementation

## PRIORITY GUIDELINES
- P0: Foundation, types, project setup, blocking dependencies
- P1: Core features, main implementation, error handling
- P2: Polish, optimization, documentation

## OUTPUT FORMAT
Return ONLY a JSON object:
{
  "items": [
    {
      "id": "P0-001",
      "content": "Write failing test for user authentication endpoint",
      "priority": "P0",
      "tddPhase": "test",
      "verificationCriteria": "Test file exists, test fails with 'not implemented'",
      "testCommand": "npm test -- --grep='auth'",
      "dependencies": []
    },
    {
      "id": "P0-002",
      "content": "Implement user authentication handler",
      "priority": "P0",
      "tddPhase": "impl",
      "verificationCriteria": "npm test -- --grep='auth' passes",
      "pairedWith": "P0-001",
      "dependencies": ["P0-001"]
    },
    {
      "id": "P0-003",
      "content": "Review auth implementation for security",
      "priority": "P0",
      "tddPhase": "review",
      "verificationCriteria": "No security issues, follows best practices",
      "reviewChecklist": ["Input validation", "XSS prevention", "Error handling"],
      "pairedWith": "P0-002",
      "dependencies": ["P0-002"]
    }
  ],
  "gaps": ["any missing requirements noted"],
  "warnings": ["any concerns or risks identified"]
}

CRITICAL REQUIREMENTS:
1. Every implementation MUST have a paired test task that comes BEFORE it
2. Every implementation MUST have a review task that comes AFTER it
3. Use sequential IDs: P0-001, P0-002, P1-001, etc.
4. verificationCriteria must be SPECIFIC and observable
5. Dependencies must form a valid DAG (no cycles)

Generate 15-40 items covering the complete implementation.`;
