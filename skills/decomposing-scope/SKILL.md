---
name: decomposing-scope
description: "스코프→에픽→스토리 분해 및 RICE 우선순위"
---

> **Paths:** File paths (`shared/`, `references/`, `../ln-*`) are relative to skills repo root. If not found at CWD, locate this SKILL.md directory and go up one level for repo root.

# Scope Decomposer (Top Orchestrator)

Top-level orchestrator for complete initiative decomposition from scope to User Stories through Epic and Story coordinators.

## Purpose

### What This Skill Does

Coordinates the complete decomposition pipeline for new initiatives:
- Auto-discovers Team ID from kanban_board.md
- **Phase 1:** Discovery (Team ID)
- **Phase 2:** Epic Decomposition (delegates to ln-210-epic-coordinator)
- **Phase 3:** Story Decomposition Loop (delegates to ln-220-story-coordinator per Epic, sequential)
- **Phase 4:** RICE Prioritization Loop (optional, delegates to ln-230-story-prioritizer per Epic, sequential)
- **Phase 5:** Summary (total counts + next steps)

### When to Use This Skill

This skill should be used when:
- Start new initiative requiring full decomposition (scope → Epics → Stories)
- Automate Epic + Story creation in single workflow
- Prefer full pipeline over manual step-by-step invocation
- Time-efficient approach for new projects (2-3 hours end-to-end)

**Alternative:** For granular control, invoke coordinators manually:
1. [ln-210-epic-coordinator](../ln-210-epic-coordinator/SKILL.md) - CREATE/REPLAN Epics
2. [ln-220-story-coordinator](../ln-220-story-coordinator/SKILL.md) - CREATE/REPLAN Stories (once per Epic)
3. [ln-230-story-prioritizer](../ln-230-story-prioritizer/SKILL.md) - RICE prioritization (once per Epic)

### When NOT to Use

Do NOT use if:
- Initiative already has Epics → Use ln-210-epic-coordinator REPLAN mode instead
- Need to replan existing Stories → Use ln-220-story-coordinator REPLAN mode per Epic
- Only need Epic creation → Use ln-210-epic-coordinator directly
- Only need Story creation for specific Epic → Use ln-220-story-coordinator directly

---


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
