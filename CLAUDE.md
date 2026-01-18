# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

This is a **Claude Code configuration template** containing reusable CLAUDE.md and settings files. Copy these to new projects to bootstrap Claude Code configuration.

### Files to Copy
- `CLAUDE.md` → project root (then customize the Project Overview section)
- `.claude/settings.json` → `.claude/settings.json`

---

## Project Overview
<!-- Customize this section when using in a real project -->
- **Project Name**: claudeman (Claude Code config template)
- **Description**: Reusable Claude Code configuration files
- **Last Updated**: 2026-01-18

---

## Work Principles

### Autonomy
Full permissions granted via `.claude/settings.json`. Act decisively - read, write, edit, execute freely.

### Git Discipline
- Commit after every meaningful change - never batch unrelated work
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- Commit message = what changed + why (not how)

### Planning Mode
**Automatically enter planning mode** when:
- Multi-file changes (3+ files)
- Architectural decisions
- New feature implementation
- Refactoring existing functionality

**Skip planning mode** for: single-file fixes, typo corrections, simple config changes.

---

## Ralph Loop (Autonomous Work)

Start with `/ralph-loop`, cancel with `/cancel-ralph`.

Ralph loops enable persistent autonomous work. When active, continue iterating until completion criteria are met.

### Core Behaviors
1. Work incrementally - one sub-task at a time
2. Commit after each completion
3. Self-correct: implement → test → fix failures → lint → fix errors → commit
4. Only output completion phrase when ALL requirements done AND tests pass

### Time-Aware Loops
When given a minimum duration, track elapsed time and self-generate additional tasks if primary work completes early. Only output completion phrase when both tasks AND time requirements are met.

---

## Session Log

| Date | Tasks Completed | Files Changed | Notes |
|------|-----------------|---------------|-------|
| 2026-01-18 | Improve CLAUDE.md template | CLAUDE.md | Made more concise |
