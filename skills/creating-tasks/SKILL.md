---
name: creating-tasks
description: "구현/리팩토링/테스트 태스크 생성"
---

> **Paths:** File paths (`shared/`, `references/`, `../ln-*`) are relative to skills repo root. If not found at CWD, locate this SKILL.md directory and go up one level for repo root.

# Universal Task Creator

Worker that generates task documents and creates Linear issues for implementation, refactoring, or test tasks as instructed by orchestrators.

## Purpose & Scope
- Owns all task templates and creation logic (Linear + kanban updates)
- Generates full task documents per type (implementation/refactoring/test)
- Enforces type-specific hard rules (no new tests in impl, regression strategy for refactoring, risk matrix and limits for test)
- Drops NFR bullets if supplied; only functional scope becomes tasks
- Never decides scope itself; uses orchestrator input (plans/results)

## Task Storage Mode

**MANDATORY READ:** Load `shared/references/storage_mode_detection.md` for Linear vs File mode operations.


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
