---
name: reviewing-code
description: "Performs comprehensive code review covering bugs, security vulnerabilities (OWASP Top 10), performance issues, and style consistency. Use when the user asks for code review, wants to check code quality, or mentions reviewing changes."
---

# Code Review

## Process

1. Scan the target files/directory for issues
2. Categorize by severity: Critical → High → Medium → Low
3. For each issue, provide fix code

## Checklist

```
Review Progress:
- [ ] Bug and logic errors
- [ ] Security vulnerabilities (OWASP Top 10)
- [ ] Performance bottlenecks
- [ ] Error handling gaps
- [ ] Code style consistency
```

## Output Format

Group by severity. For each issue:
- File and line number
- Issue description (1 sentence)
- Suggested fix (code block)

Keep output concise. Skip issues that are purely stylistic unless they affect readability.

## Advanced

For deep security analysis, see [security-checklist.md](security-checklist.md).
