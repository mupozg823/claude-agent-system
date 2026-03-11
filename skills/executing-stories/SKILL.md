---
name: executing-stories
description: "스토리 태스크 실행 오케스트레이터"
---

> **Paths:** File paths (`shared/`, `references/`, `../ln-*`) are relative to skills repo root. If not found at CWD, locate this SKILL.md directory and go up one level for repo root.

# Story Execution Orchestrator

Executes a Story end-to-end by looping through its tasks in priority order. Sets Story to **To Review** when all tasks Done (quality gate decides Done).

## Purpose & Scope
- Load Story + task metadata (no descriptions) and drive execution
- Process tasks in order: To Review → To Rework → Todo (foundation-first within each status)
- Delegate per task type to appropriate workers (see Worker Invocation table)
- **Mandatory immediate review:** Every execution/rework → ln-402 immediately. No batching

## Task Storage Mode

**MANDATORY READ:** Load `shared/references/storage_mode_detection.md` for Linear vs File mode detection and operations.


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
