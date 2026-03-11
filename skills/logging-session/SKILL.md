---
name: logging-session
description: "Saves current session work log as markdown to ~/.claude/logs/. Use when the user says /log, asks to save session log, or wants to record what was done."
---

# Session Log

Save all work performed in this session to `~/.claude/logs/`.

## File Naming

`YYYY-MM-DD_HH-MM_topic-summary.md`

## Content Template

```markdown
# Session Log: [topic]
Date: [YYYY-MM-DD HH:MM]

## Summary
[One line summary]

## Tasks Completed
- [x] Task 1
- [x] Task 2

## Files Changed
- `path/to/file` — description

## Key Commands
```bash
command 1
command 2
```

## Issues & Solutions
- Issue: [description] → Fix: [solution]

## Next Steps
- [ ] Follow-up task (if any)
```

Write the file using the Write tool. Confirm the path after saving.
