# ADR-002: Security Hardening — Command Injection & Tool Restriction

**Status**: Proposed
**Date**: 2026-03-11
**Deciders**: System Architect
**Context**: v8 Sprint 1

---

## Context

### 문제 1: Command Injection (CRITICAL)

`telegram-adapter.js`에서 사용자 입력이 `execSync`에 직접 전달된다:

```javascript
// telegram-adapter.js L347 (현재)
execSync(`claude -p "${userMessage}"`, { ... });
```

공격 벡터: `"; rm -rf / #` → 쉘 명령 주입 가능

### 문제 2: Agent Teams 도구 제한 미적용 (HIGH)

`orchestrator-v2.js`에서 역할별 도구 목록이 선언만 되고 적용되지 않는다:

```javascript
// 선언
architect: { tools: ['Read', 'Grep', 'Glob'] }

// 실행 — 제한 없음
execFileSync('claude', ['-p', prompt, '--output-format', 'text'])
```

Architect가 `Edit`, `Write`, `Bash` 전부 사용 가능 → 역할 분리 무의미

### 문제 3: Supabase 키 노출 (MEDIUM)

`dashboard-remote.html`에 anon key가 하드코딩:
```html
const SUPABASE_KEY = 'eyJ...'  // 공개 파일에 노출
```

## Decision

### D1: execSync → execFileSync 전환 (telegram-adapter.js)

```javascript
// Before (취약)
execSync(`claude -p "${msg}"`, opts);

// After (안전)
execFileSync('claude', ['-p', msg, '--output-format', 'text'], opts);
```

`execFileSync`는 쉘을 거치지 않으므로 인젝션 불가능.

### D2: --allowedTools 적용 (orchestrator-v2.js)

```javascript
// Before
execFileSync('claude', ['-p', prompt, '--output-format', 'text'])

// After
const args = ['-p', prompt, '--output-format', 'text'];
if (role.tools && role.tools.length > 0) {
  args.push('--allowedTools', JSON.stringify(role.tools));
}
execFileSync('claude', args, opts);
```

CLI에서 `--allowedTools` 미지원 시 대안:
- system prompt에 `CRITICAL: You may ONLY use these tools: [...]` 강제 삽입
- 결과 감사: 실행 후 사용된 도구 목록 검증

### D3: Supabase 키 환경변수 전환

```javascript
// Before
const SUPABASE_KEY = 'eyJ...';

// After
const SUPABASE_KEY = window.__SUPABASE_KEY || '';
// 또는 서버 사이드에서 주입
```

### D4: relay-supabase.js 명령 allowlist 강화

```javascript
// 현재: 문자열 비교
const ALLOWED = ['status', 'metrics', 'logs', 'queue-list'];

// 강화: 정규식 + 파라미터 검증
const COMMAND_SCHEMA = {
  status: { args: 0 },
  metrics: { args: 0 },
  'queue-add': { args: 1, validate: (arg) => arg.length < 500 },
};
```

## Alternatives Considered

### A1: 입력 이스케이프 (sanitize)
- **기각**: 이스케이프는 우회 가능. `execFileSync`가 근본적 해결.

### A2: Docker 격리로 Agent Teams 실행
- **기각**: 오버엔지니어링. CLI 파라미터로 충분.

### A3: Supabase 키를 `.env`에 보관
- **부분 채택**: 서버 사이드에서는 `.env`, 클라이언트는 동적 주입

## Consequences

### Positive
- CRITICAL 취약점 0건
- Agent Teams 역할 분리 실제 적용
- 감사 로그에서 도구 사용 추적 가능

### Negative
- `execFileSync`로 전환 시 일부 쉘 기능(파이프, 리다이렉트) 사용 불가
  - Mitigation: 필요한 경우 명시적으로 `['sh', '-c', safeCmd]` 사용
