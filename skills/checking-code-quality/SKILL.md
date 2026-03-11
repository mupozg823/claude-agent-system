---
name: checking-code-quality
description: "코드 품질 메트릭 측정 및 분석"
---

# Code Metrics Reference

Quantitative thresholds and penalties based on goodcodeguide methodology.

## Cyclomatic Complexity

| Range | Status | Interpretation |
|-------|--------|----------------|
| 1-10 | Good | Maintainable, easily testable |
| 11-20 | Warning | Moderate complexity, consider refactoring |
| 21-50 | High | Difficult to test, should refactor |
| >50 | Critical | Untestable, must refactor |

**Penalty calculation:**
- 11-20: -5 points per function
- >20: -10 points per function

**How to estimate CC:**
- Count decision points: `if`, `else if`, `case`, `while`, `for`, `&&`, `||`, `?:`
- Base complexity = 1
- CC = base + decision_points


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
