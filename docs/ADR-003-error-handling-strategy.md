# ADR-003: Error Handling Strategy — Empty Catch Elimination

**Status**: Proposed
**Date**: 2026-03-11
**Deciders**: System Architect
**Context**: v8 Sprint 2

---

## Context

현재 시스템에 **91개의 `catch {}` (empty catch)** 블록이 존재한다.
원래 의도는 "hooks는 절대 부모 프로세스를 크래시시키면 안 된다"였으나,
결과적으로 모든 에러가 삼켜져서 운영 디버깅이 불가능하다.

```javascript
// 현재 패턴 (91곳)
try { doSomething(); } catch { /* silent */ }
```

문제:
- 파일 쓰기 실패 → 감사 로그 누락 (발견 불가)
- JSON 파싱 실패 → 빈 데이터로 진행 (잘못된 결과)
- 네트워크 오류 → 릴레이 중단 (원인 불명)

## Decision

### 3-Tier Error Handling 전략

**Tier 1: Critical Path — 로그 + 계속**
감사 로그, 텔레메트리, 체크포인트 등 데이터 무결성 영향.

```javascript
// Before
try { appendJsonl(auditFile, entry); } catch {}

// After
try {
  appendJsonl(auditFile, entry);
} catch (e) {
  logError('audit-log', 'write-failed', e);
  // 계속 진행 (hook은 크래시하면 안 됨)
}
```

**Tier 2: Optional Enhancement — silent skip OK**
캐시 lookup, 텔레메트리 부스트 등 실패해도 기능에 영향 없음.

```javascript
// 유지 가능 (but 주석 명시)
try { cache.set(key, value); } catch { /* cache miss is OK */ }
```

**Tier 3: Never Silent — 반드시 로그**
외부 통신, 프로세스 실행, 파일 생성 등.

```javascript
// Before
try { execSync(cmd); } catch {}

// After
try {
  execSync(cmd);
} catch (e) {
  logError('orchestrator', 'exec-failed', e);
  throw e; // 또는 return error result
}
```

### 공통 에러 핸들러: `hooks/lib/errors.js`

```javascript
// hooks/lib/errors.js
const fs = require('fs');
const path = require('path');

const ERROR_LOG = path.join(
  process.env.HOME || '/root', '.claude', 'logs', 'errors.jsonl'
);

function logError(module, action, error) {
  const entry = {
    ts: new Date().toISOString(),
    module,
    action,
    msg: (error.message || String(error)).slice(0, 500),
  };
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + '\n');
  } catch { /* last resort: truly silent */ }
  // Also stderr for hook debugging
  process.stderr.write(`[${module}] ${action}: ${entry.msg}\n`);
}

module.exports = { logError };
```

### 분류 기준

| Tier | 조건 | catch 처리 | 대상 수 |
|------|------|-----------|---------|
| 1 | 데이터 쓰기/읽기 | `logError()` + 계속 | ~40 |
| 2 | 캐시/부스트/선택적 | `/* reason */` 주석 | ~30 |
| 3 | 프로세스/통신/핵심 | `logError()` + throw/return | ~21 |

## Alternatives Considered

### A1: 전부 logError로 변환
- **기각**: Tier 2 (캐시 미스 등)까지 로깅하면 노이즈 과다

### A2: Sentry/외부 모니터링 연동
- **기각**: 오버엔지니어링. JSONL 에러 로그로 충분

### A3: 현상 유지
- **기각**: 디버깅 불가 상태는 시스템 성숙도에 치명적

## Consequences

### Positive
- 에러 원인 추적 가능 (`~/.claude/logs/errors.jsonl`)
- 숨겨진 버그 발견 (의도적 노출)
- Hook 안정성 유지 (logError는 절대 throw 안 함)

### Negative
- 일시적 에러 로그 증가 (정상적으로 무시되던 에러가 보임)
- 모든 catch 수정 필요 (~70개 변경)

### Migration Path
1. `hooks/lib/errors.js` 생성
2. Tier 3 (프로세스/통신) 먼저 변환 (21개)
3. Tier 1 (데이터 I/O) 변환 (40개)
4. Tier 2에 주석 추가 (30개)
