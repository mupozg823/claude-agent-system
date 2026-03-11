---
name: debugging-errors
description: "Systematic error analysis and debugging using root cause analysis, stack trace parsing, and fix verification. Use when user encounters errors, bugs, exceptions, or asks for debugging help."
---

# Error Debugging

## Process

```
Debug Progress:
- [ ] Step 1: Reproduce and capture error
- [ ] Step 2: Parse stack trace / error message
- [ ] Step 3: Identify root cause
- [ ] Step 4: Implement fix
- [ ] Step 5: Verify fix
```

## Step 1: Reproduce
Run the failing command/test. Capture full error output.

## Step 2: Parse
Extract from error:
- Error type and message
- File and line number
- Call stack (most recent first)
- Related state/input

## Step 3: Root Cause
Use Grep to search for the error pattern in codebase.
Check recent changes (`git log --oneline -10`, `git diff HEAD~3`).
Identify: is it logic error, missing dependency, config issue, or data problem?

## Step 4: Fix
Apply minimal, targeted fix. Don't refactor surrounding code.

## Step 5: Verify
Re-run the original failing command. Run related tests.
If fix introduces new failures, iterate from Step 2.
