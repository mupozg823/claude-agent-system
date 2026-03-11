---
name: developing-features
description: "Orchestrates full feature development using specialized agents for architecture, implementation, testing, and review. Use when user wants to build a new feature, implement a story, or develop functionality end-to-end."
---

# Feature Development Workflow

## Process

```
Analyze Progress:
- [ ] Step 1: Understand requirements
- [ ] Step 2: Architecture design
- [ ] Step 3: Implementation
- [ ] Step 4: Testing
- [ ] Step 5: Code review
```

## Step 1: Requirements
Parse the feature request. Identify scope, constraints, and acceptance criteria.

## Step 2: Architecture
Use Agent tool (subagent_type: Plan) to design the implementation:
- File structure
- Key interfaces
- Dependencies

## Step 3: Implementation
Use Agent tool (subagent_type: general-purpose) for parallel independent tasks.
Implement sequentially for dependent code.

## Step 4: Testing
Write tests alongside implementation. Run existing test suite to verify no regressions.

## Step 5: Review
Self-review the changes for bugs, security, and style before presenting to user.

## TDD Mode
For test-first development, reverse Steps 3-4: write tests first, then implement until green.
