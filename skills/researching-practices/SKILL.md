---
name: researching-practices
description: "모범사례 리서치 및 문서화 (Guide/Manual/ADR/Research)"
---

> **Paths:** File paths (`shared/`, `references/`, `../ln-*`) are relative to skills repo root. If not found at CWD, locate this SKILL.md directory and go up one level for repo root.

# Best Practices Researcher

Research industry standards and create project documentation in one workflow.

## Purpose & Scope
- Research via MCP Ref + Context7 for standards, patterns, versions
- Create 4 types of documents from research results:
  - Guide: Pattern documentation (Do/Don't/When table)
  - Manual: API reference (methods/params/doc links)
  - ADR: Architecture Decision Record (Q&A dialog)
  - Research: Investigation document answering specific question
- Return document path for linking in Stories/Tasks

## Phase 0: Stack Detection

**Objective**: Identify project stack to filter research queries and adapt output.

**Detection:**

| Indicator | Stack | Query Prefix | Official Docs |
|-----------|-------|--------------|---------------|
| `*.csproj`, `*.sln` | .NET | "C# ASP.NET Core" | Microsoft docs |
| `package.json` + `tsconfig.json` | Node.js | "TypeScript Node.js" | MDN, npm docs |
| `requirements.txt`, `pyproject.toml` | Python | "Python" | Python docs, PyPI |
| `go.mod` | Go | "Go Golang" | Go docs |
| `Cargo.toml` | Rust | "Rust" | Rust docs |
| `build.gradle`, `pom.xml` | Java | "Java" | Oracle docs, Maven |

**Usage:**
- Add `query_prefix` to all MCP search queries
- Link to stack-appropriate official docs


## Detailed Reference

For complete instructions, see [reference.md](reference.md).
