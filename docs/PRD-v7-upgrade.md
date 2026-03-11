# PRD: Claude Agent System v7 업그레이드

> **문서 버전**: 1.0
> **작성일**: 2026-03-11
> **상태**: Draft
> **작성자**: AI Architecture Team
> **대상**: v6 → v7 아키텍처 업그레이드

---

## 1. 개요 (Executive Summary)

### 1.1 제품 비전

Claude Agent System은 Claude Code CLI 위에 구축된 **자율 에이전트 스캐폴드**로, 세션 체크포인트, 감사 로그, 토큰 예산 추적, 품질 게이트, 원격 모니터링 등의 기능을 제공한다. v7은 Claude Code 2026.03 신규 기능(Async Hooks, HTTP Hooks, Agent Teams, Skills 2.0, 1M 컨텍스트)을 완전 활용하여 **성능 5배, 토큰 50% 절감, 보안 취약점 0건**을 달성하는 것이 목표이다.

### 1.2 현행 시스템 요약 (v6)

| 항목 | 현황 |
|------|------|
| 코드베이스 | 8.3K LOC, Node.js (CommonJS) |
| 훅 모듈 | 23개 파일 (hooks/) |
| 스킬 | 48개 Skills 2.0 + 48개 Legacy Commands |
| 테스트 | 25개 (20 pass / 5 fail) |
| 데몬 | 5개 (gateway, relay, telegram, heartbeat, orchestrator) |
| 컨텍스트 | 200K 토큰 고정 |
| 종합 품질 점수 | 5.7/10 (ECC 대비 -2.0) |

### 1.3 핵심 문제 (Why v7?)

| # | 문제 | 정량 근거 | 영향도 |
|---|------|-----------|--------|
| P1 | 매 도구 호출마다 훅이 차단 (42ms/call) | 세션당 ~200회 × 42ms = **8.4초 낭비** | 🔴 높음 |
| P2 | 200K 토큰 고정으로 불필요한 조기 컴팩션 | Opus 4.6은 1M 지원, 컴팩션 10회/세션 | 🔴 높음 |
| P3 | 테스트 5건 실패 + 신규 모듈 0건 | 25 tests vs ECC 997 tests | 🔴 높음 |
| P4 | telegram-adapter 커맨드 인젝션 | CRITICAL 보안 취약점 (L347, L575) | 🔴 높음 |
| P5 | 메모리 누수 (unbounded 배열/Map) | 장기 실행 시 OOM 가능 | 🟡 중간 |
| P6 | Skills가 메인 컨텍스트 소비 | subagent 격리 미사용 → 토큰 낭비 | 🟡 중간 |
| P7 | 인프라 데몬이 hooks/에 혼재 | 유지보수 복잡성 증가 | 🟢 낮음 |

### 1.4 성공 기준 (KPIs)

| 지표 | 현행 (v6) | 목표 (v7) | 측정 방법 |
|------|-----------|-----------|-----------|
| 훅 차단 시간 | 42ms/call | **0ms** (async) | telemetry.js hook_latency_ms |
| 컨텍스트 윈도우 | 200K | **1M** (환경변수) | token-budget.js MAX_CONTEXT_TOKENS |
| 컴팩션 빈도 | ~10회/세션 | **~2회/세션** | telemetry.js compactions |
| 테스트 통과율 | 80% (20/25) | **100%** (75/75+) | tests/run-all.js |
| 보안 취약점 | 1 CRITICAL | **0** | security audit |
| 메모리 누수 | 2건 | **0건** | 장기 실행 모니터링 |
| 종합 점수 | 5.7/10 | **7.7/10** | 7차원 평가 |

---

## 2. 이해관계자 및 사용자 (Stakeholders)

### 2.1 주요 사용자

| 사용자 | 역할 | 관심사 |
|--------|------|--------|
| **개발자 (1인)** | 시스템 소유자 + 일상 사용자 | 세션 효율, 토큰 비용, 코드 품질 |
| **Claude Code** | 호스트 플랫폼 | 훅 API 호환성, 성능 |
| **원격 클라이언트** | Telegram/Supabase 통한 모니터링 | 안정성, 보안 |

### 2.2 의존성

| 의존성 | 버전 | 용도 | 위험 |
|--------|------|------|------|
| Node.js | 22.x | 런타임 | 낮음 |
| Claude Code CLI | 2026.03.07+ | 호스트 | **높음** — API 변경 시 영향 |
| better-sqlite3 | optional | Telegram 세션 영속 | 중간 — 미설치 시 인메모리 fallback |
| ws | optional | Gateway WebSocket | 중간 — 미설치 시 모듈 로드 실패 |

---

## 3. 기능 요구사항 (Functional Requirements)

### FR-1: Async Hook Pipeline

**우선순위**: P0 (Sprint 1)
**목적**: PostToolUse audit-log 훅의 비차단 실행

#### 3.1.1 현행 동작
```
도구 실행 → PostToolUse 훅 호출 → audit-log.js 동기 실행 (42ms) → 다음 도구 실행
```

#### 3.1.2 목표 동작
```
도구 실행 → PostToolUse 훅 비동기 호출 → 즉시 다음 도구 실행
                                       ↘ audit-log.js 백그라운드 실행
```

#### 3.1.3 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-1.1 | settings.json의 PostToolUse 훅에 `"async": true` 추가 | 훅 등록 후 차단 없이 동작 확인 |
| FR-1.2 | audit-log.js의 동작 변경 없음 (입출력 동일) | 기존 JSONL 형식 유지, 감사 로그 정상 기록 |
| FR-1.3 | 비동기 실패 시 에러가 세션에 영향 없음 | audit-log 크래시 시 메인 세션 정상 |
| FR-1.4 | 기존 settings.json의 다른 훅 설정 보존 | Stop 훅 등 기존 설정 변경 없음 |

#### 3.1.4 변경 파일

| 파일 | 위치 | 변경 내용 |
|------|------|-----------|
| `settings.json` | `/root/.claude/settings.json` | PostToolUse 훅 추가 (`async: true`) |

#### 3.1.5 제약사항
- Claude Code의 `async` 플래그는 훅 프로세스의 stdout을 무시함
- 따라서 async 훅은 `systemMessage` 주입 불가 — audit-log은 원래 `{}` 반환이므로 문제 없음
- 동시 실행 시 파일 append 경합 가능 — OS 레벨 atomic append에 의존 (현행과 동일)

---

### FR-2: 1M 토큰 컨텍스트 지원

**우선순위**: P0 (Sprint 1)
**목적**: Opus 4.6 1M 컨텍스트 윈도우 활용

#### 3.2.1 현행 동작
```javascript
const MAX_CONTEXT_TOKENS = 200000; // 고정값
// 85% (170K)에서 compact-now 트리거 → 세션당 ~10회 컴팩션
```

#### 3.2.2 목표 동작
```javascript
const MAX_CONTEXT_TOKENS = process.env.CLAUDE_CONTEXT_1M === '1'
  ? 1000000   // Opus 4.6 1M beta
  : 200000;   // Standard

// 1M 모드: 95%에서 compact-now (950K) → 세션당 ~2회 컴팩션
```

#### 3.2.3 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-2.1 | `CLAUDE_CONTEXT_1M=1` 환경변수로 1M 모드 활성화 | 환경변수 설정 시 MAX_CONTEXT_TOKENS=1000000 |
| FR-2.2 | 환경변수 미설정 시 기존 200K 유지 | 하위 호환성 보장 |
| FR-2.3 | 1M 모드의 적응형 컴팩션 임계값 조정 | compact-now: 95%, compact-soon: 90% |
| FR-2.4 | StatusLine 표시에 1M 모드 반영 | 프로그레스 바가 1M 기준으로 표시 |
| FR-2.5 | 기존 burn rate 기반 적응형 로직 유지 | 200K 모드와 1M 모드 모두 burn rate 반영 |

#### 3.2.4 변경 파일

| 파일 | 위치 | 변경 내용 |
|------|------|-----------|
| `token-budget.js` | `/root/.claude/hooks/token-budget.js` | MAX_CONTEXT_TOKENS 동적 설정, 1M 임계값 추가 |

#### 3.2.5 적응형 컴팩션 매트릭스

**200K 모드 (기존)**:
| Burn Rate | compact-soon | compact-now |
|-----------|-------------|-------------|
| 높음 (>5000 t/m) | 60% | 70% |
| 중간 (>2000 t/m) | 75% | 85% |
| 낮음 (≤2000 t/m) | 85% | 90% |

**1M 모드 (신규)**:
| Burn Rate | compact-soon | compact-now |
|-----------|-------------|-------------|
| 높음 (>5000 t/m) | 85% | 90% |
| 중간 (>2000 t/m) | 90% | 95% |
| 낮음 (≤2000 t/m) | 93% | 97% |

---

### FR-3: 테스트 수정 및 확장

**우선순위**: P0 (Sprint 1)
**목적**: 깨진 테스트 5건 수정 + 테스트 인프라 안정화

#### 3.3.1 현행 실패 테스트 분석

| # | 테스트 | 실패 원인 | 수정 방안 |
|---|--------|-----------|-----------|
| 1 | `smart-approve.js auto-approves safe command` | `smart-approve.js` 파일 삭제됨 | 테스트 제거 또는 skip |
| 2 | `smart-approve.js blocks dangerous command` | 동일 | 테스트 제거 또는 skip |
| 3 | `SessionStore CRUD works in memory` | `better-sqlite3` 미설치 → 인메모리 fallback이 실제 DB 기능 미제공 | 의존성 없을 시 skip 처리 |
| 4 | `SessionStore listSessions returns array` | 동일 | 의존성 없을 시 skip 처리 |
| 5 | `gateway loads without error` | `ws` 모듈 미설치 | 의존성 없을 시 skip 처리 |

#### 3.3.2 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-3.1 | smart-approve.js 관련 2개 테스트 제거 | 해당 파일이 존재하지 않으므로 테스트 무의미 |
| FR-3.2 | better-sqlite3 미설치 시 SessionStore 테스트 skip | `skip()` 처리 + 사유 표시 |
| FR-3.3 | ws 미설치 시 gateway 로드 테스트 skip | `skip()` 처리 + 사유 표시 |
| FR-3.4 | 신규 v6 모듈 테스트 추가 (cache, telemetry, token-budget, context-engine, quality-gate) | 최소 50개 테스트 |
| FR-3.5 | 모든 테스트 통과 (0 fail) | `node tests/run-all.js` exit code 0 |

#### 3.3.3 신규 테스트 계획

**lib/cache.js 테스트 (10개)**:
| # | 테스트 명 | 검증 내용 |
|---|----------|-----------|
| 1 | TTLCache stores and retrieves values | set/get 기본 동작 |
| 2 | TTLCache expires entries after TTL | TTL 초과 시 undefined |
| 3 | TTLCache delete removes entry | 명시적 삭제 |
| 4 | LRUCache respects max size | max 초과 시 oldest 제거 |
| 5 | LRUCache updates access order on get | 접근 시 순서 갱신 |
| 6 | getSkillRules loads and caches | 파일 로드 + 캐시 히트 |
| 7 | getSkillRules reloads on mtime change | 파일 변경 시 재로드 |
| 8 | getCompiledPatterns returns Map of RegExp | 정규식 사전 컴파일 검증 |
| 9 | initSeqFromDisk loads initial sequence | 디스크 → 메모리 초기화 |
| 10 | nextSeq increments monotonically | 순차 증가 검증 |

**telemetry.js 테스트 (10개)**:
| # | 테스트 명 | 검증 내용 |
|---|----------|-----------|
| 1 | recordHookLatency adds entry | 배열 추가 확인 |
| 2 | recordFileChange tracks unique files | Set 동작 |
| 3 | recordFileChange detects rework | 동일 파일 2+ 편집 |
| 4 | latencyStats computes avg/p50/p95/max | 통계 정확성 |
| 5 | latencyStats handles empty array | 빈 배열 → 0 |
| 6 | reworkCount returns excess edits | rework 카운트 정확성 |
| 7 | flush writes metrics to disk | JSONL 기록 확인 |
| 8 | flush includes all metric fields | 필수 필드 존재 |
| 9 | readMetrics reads files within range | 날짜 범위 필터링 |
| 10 | weeklyReport generates formatted output | 비어있지 않은 문자열 |

**token-budget.js 테스트 (10개)**:
| # | 테스트 명 | 검증 내용 |
|---|----------|-----------|
| 1 | getTokenBudget returns required fields | used, remaining, usedPct, burnRate, estimatedTurns, action |
| 2 | recordTurn increments turnCount | 턴 카운트 증가 |
| 3 | recordCompaction reduces tokenEstimate | 0.3배 감소 |
| 4 | formatStatusLine returns progress bar | 이모지 + 바 + 퍼센트 |
| 5 | getSkillTokenCost returns known skill cost | reviewing-code → 5000 |
| 6 | getSkillTokenCost returns default for unknown | unknown → 500 |
| 7 | canAffordSkill returns true when budget ample | 충분 시 true |
| 8 | canAffordSkill returns false when low budget | 부족 시 false |
| 9 | 1M mode uses correct MAX_CONTEXT_TOKENS | env 설정 시 1000000 |
| 10 | adaptive compaction thresholds vary by burn rate | burn rate별 임계값 차이 |

**context-engine.js 테스트 (10개)**:
| # | 테스트 명 | 검증 내용 |
|---|----------|-----------|
| 1 | createSnapshot returns valid object | 필수 필드 존재 (version, ts, git, tasks) |
| 2 | createSnapshot captures git state | branch, lastCommit 포함 |
| 3 | restoreSnapshot returns null when no snapshot | 스냅샷 없을 시 null |
| 4 | formatSnapshotContext produces compact text | 500 토큰 이하 길이 |
| 5 | extractDecisions finds DECISION markers | [DECISION] 패턴 감지 |
| 6 | extractDecisions handles empty array | 빈 배열 → 빈 결과 |
| 7 | extractArchitecture maps file frequency | 빈도 높은 파일 추출 |
| 8 | cleanupSnapshots keeps max 10 | 11개 생성 → 10개 유지 |
| 9 | snapshot version matches expected | version 필드 존재 및 정합성 |
| 10 | restoreSnapshot uses cache on repeat call | 두 번째 호출은 캐시 히트 |

**quality-gate.js 테스트 (10개)**:
| # | 테스트 명 | 검증 내용 |
|---|----------|-----------|
| 1 | runChecks returns result object | verdict, issues, warnings 필드 |
| 2 | clean verdict when no changes | git diff 비어있으면 clean |
| 3 | detects sensitive files | .env 파일 변경 시 fail |
| 4 | warns on large diff | 500+ 라인 diff 시 warning |
| 5 | suggests split on large diff | >500 라인 → split 추천 |
| 6 | runAndRecord writes to audit log | 감사 로그에 quality-gate 이벤트 |
| 7 | isSensitiveFile matches .env patterns | 다양한 민감 파일 패턴 |
| 8 | isSensitiveFile passes safe files | .js, .md 등 안전 파일 |
| 9 | lint check detects JS errors | ESLint 사용 가능 시 에러 감지 |
| 10 | verdict is pass when only warnings | 경고만 있으면 pass_with_warnings |

#### 3.3.4 변경 파일

| 파일 | 위치 | 변경 내용 |
|------|------|-----------|
| `tests/run-all.js` | `/home/user/claude-agent-system/tests/run-all.js` | smart-approve 제거, skip 처리 |
| `tests/v6-modules.test.js` | `/home/user/claude-agent-system/tests/v6-modules.test.js` (신규) | 50개 테스트 |

---

### FR-4: 메모리 누수 수정

**우선순위**: P0 (Sprint 1)
**목적**: 장기 실행 안정성 확보

#### 3.4.1 식별된 누수

| # | 위치 | 데이터 구조 | 문제 | 수정 |
|---|------|-------------|------|------|
| 1 | `telemetry.js:22` | `_metrics.hookLatencies` (Array) | 무한 증가 | **max 1000** 엔트리, FIFO |
| 2 | `telemetry.js:25` | `_metrics.reworkFiles` (Map) | 무한 증가 | **max 500** 엔트리, LRU |
| 3 | `telemetry.js:24` | `_metrics.filesChanged` (Set) | 무한 증가 | **max 500** 엔트리 |
| 4 | `lib/utils.js:108` | `_latestFileCache` (Map) | TTL만 있고 크기 제한 없음 | **max 20** 엔트리 + 정리 |
| 5 | `token-budget.js:153` | `state.burnSamples` (Array) | 50개 제한 있음 (OK) | 변경 불필요 |

#### 3.4.2 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-4.1 | `hookLatencies` 배열 최대 1000 엔트리 | 1001번째 push 시 oldest 제거 |
| FR-4.2 | `reworkFiles` Map 최대 500 엔트리 | 501번째 set 시 oldest 제거 |
| FR-4.3 | `filesChanged` Set 최대 500 엔트리 | 501번째 add 시 무시 또는 oldest 제거 |
| FR-4.4 | `_latestFileCache` Map 최대 20 엔트리 | 21번째 set 시 oldest 제거 |
| FR-4.5 | 기존 기능 변경 없음 | 메트릭 정확성 유지 |

#### 3.4.3 변경 파일

| 파일 | 위치 | 변경 내용 |
|------|------|-----------|
| `telemetry.js` | `/root/.claude/hooks/telemetry.js` | 배열/Map/Set 크기 제한 추가 |
| `lib/utils.js` | `/root/.claude/hooks/lib/utils.js` | _latestFileCache 크기 제한 |

---

### FR-5: 보안 취약점 수정 (telegram-adapter)

**우선순위**: P0 (Sprint 2)
**목적**: CRITICAL 커맨드 인젝션 취약점 해소

#### 3.5.1 취약점 상세

**위치**: `/root/.claude/hooks/telegram-adapter.js`

| 라인 | 코드 | 취약점 |
|------|------|--------|
| L347 | `execSync(\`claude ... "${userMessage}"\`)` | `"` 이스케이프만 적용, `$()` / 백틱 / `\n` 인젝션 |
| L575 | `execSync(\`claude ... "${command}"\`)` | 동일 |

**공격 벡터**:
```
사용자 입력: hello$(rm -rf /)
현행 이스케이프: hello$(rm -rf /)  → 인젝션 성공
```

#### 3.5.2 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-5.1 | `execSync` → `execFileSync` 또는 `spawn` 전환 | 쉘 해석 없이 직접 실행 |
| FR-5.2 | 사용자 입력을 인자 배열로 전달 (쉘 이스케이프 불필요) | `['claude', '--message', userInput]` 형태 |
| FR-5.3 | 입력 검증 강화 | `$()`, 백틱, 줄바꿈, `\x00` 차단 또는 이스케이프 |
| FR-5.4 | 기존 `isAllowed` 블록리스트 유지 + 강화 | `base64`, `eval`, `exec` 패턴 추가 |
| FR-5.5 | 변경 후 기존 Telegram 기능 정상 동작 | 메시지 전송/수신, 세션 관리 |

#### 3.5.3 수정 전후 비교

**Before (취약)**:
```javascript
const escaped = message.replace(/"/g, '\\"');
execSync(`claude --message "${escaped}" ...`);
```

**After (안전)**:
```javascript
const { execFileSync } = require('child_process');
execFileSync('claude', ['--message', message, ...], { encoding: 'utf8' });
```

#### 3.5.4 변경 파일

| 파일 | 위치 | 변경 내용 |
|------|------|-----------|
| `telegram-adapter.js` | `/root/.claude/hooks/telegram-adapter.js` | execSync → execFileSync, 입력 검증 |

---

### FR-6: Skills 2.0 완전 전환

**우선순위**: P1 (Sprint 2)
**목적**: 스킬 실행의 subagent 격리로 메인 컨텍스트 토큰 50% 절감

#### 3.6.1 현행 동작
```
사용자 "코드 리뷰해줘"
→ skill-suggest.js: reviewing-code 추천
→ Skill 도구 호출 → SKILL.md 로드 → 메인 컨텍스트에서 실행 (토큰 소비)
```

#### 3.6.2 목표 동작
```
사용자 "코드 리뷰해줘"
→ skill-suggest.js: reviewing-code 추천
→ Skill 도구 호출 → SKILL.md 로드 → subagent에서 격리 실행 (메인 컨텍스트 보호)
```

#### 3.6.3 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-6.1 | 주요 5개 스킬에 Skills 2.0 메타데이터 추가 | `allowed_tools`, `model`, `max_turns` 필드 |
| FR-6.2 | 읽기 전용 스킬은 Write/Edit 도구 차단 | reviewing-code: `allowed_tools: [Read, Grep, Glob]` |
| FR-6.3 | 경량 스킬은 Sonnet 모델 사용 | `model: claude-sonnet-4-6` |
| FR-6.4 | 모든 스킬에 턴 제한 설정 | `max_turns: 10-30` (스킬별 조정) |
| FR-6.5 | 기존 48개 Legacy Commands 유지 (하위 호환) | `/log`, `/status` 등 기존 명령 정상 동작 |

#### 3.6.4 대상 스킬 (5개)

| 스킬 | allowed_tools | model | max_turns | 이유 |
|------|---------------|-------|-----------|------|
| reviewing-code | Read, Grep, Glob | sonnet | 20 | 읽기 전용, 빈번 사용 |
| debugging-errors | Read, Grep, Glob, Bash | opus | 30 | 실행 필요 |
| checking-status | Read, Bash | sonnet | 10 | 경량 |
| logging-session | Read, Write | sonnet | 10 | 로그 기록만 |
| scanning-security | Read, Grep, Glob, Bash | sonnet | 20 | 읽기+실행 |

#### 3.6.5 변경 파일

| 파일 | 변경 내용 |
|------|-----------|
| `skills/reviewing-code/SKILL.md` | frontmatter에 allowed_tools, model, max_turns 추가 |
| `skills/debugging-errors/SKILL.md` | 동일 |
| `skills/checking-status/SKILL.md` | 동일 |
| `skills/logging-session/SKILL.md` | 동일 |
| `skills/scanning-security/SKILL.md` | 동일 |

---

### FR-7: 3-Tier Stop Hook

**우선순위**: P1 (Sprint 2)
**목적**: 세션 종료 판단 정확도 향상

#### 3.7.1 현행 구조
```
Stop → command: stop-check.js (키워드 분석)
     → prompt: "세션이 완료되었는지 평가하세요..." (애매한 경우만)
```

#### 3.7.2 목표 구조
```
Stop → command: stop-check.js          (빠른 키워드 체크, <10ms)
     → prompt: 시맨틱 평가              (command가 "ambiguous" 반환 시)
     → agent: quality-gate 딥 분석      (코드 변경이 있는 경우만)
```

#### 3.7.3 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-7.1 | command 훅이 결정적 판단 (continue/allow) 또는 "ambiguous" 반환 | 80% 이상 결정적 판단 |
| FR-7.2 | prompt 훅이 ambiguous 케이스만 처리 | command 통과 시 prompt 미실행 |
| FR-7.3 | agent 훅이 변경 파일 품질 검증 | 파일 변경 있을 때만 실행 |
| FR-7.4 | agent 훅에 도구 제한 | `tools: ["Bash", "Read", "Grep"]` 만 허용 |
| FR-7.5 | settings.json에 3-tier 등록 | Stop 이벤트에 3개 훅 순차 등록 |

#### 3.7.4 변경 파일

| 파일 | 변경 내용 |
|------|-----------|
| `settings.json` | Stop 이벤트에 command + prompt + agent 등록 |
| `stop-check.js` | ambiguous 판단 로직 강화 |

---

### FR-8: HTTP Hook 텔레메트리

**우선순위**: P2 (Sprint 3)
**목적**: relay-supabase.js 데몬 제거, 아키텍처 단순화

#### 3.8.1 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-8.1 | Notification 이벤트에 HTTP hook 등록 | settings.json에 `type: "http"` 설정 |
| FR-8.2 | 텔레메트리 데이터를 HTTP endpoint로 직접 전송 | Supabase Functions 또는 커스텀 endpoint |
| FR-8.3 | async 모드로 비차단 전송 | 세션 성능에 영향 없음 |
| FR-8.4 | 전송 실패 시 로컬 폴백 유지 | 오프라인에서도 로컬 JSONL 기록 |

---

### FR-9: Agent Teams 오케스트레이터

**우선순위**: P2 (Sprint 3)
**목적**: 복잡 작업의 병렬 처리 속도 2-3배 향상

#### 3.9.1 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-9.1 | 기존 DAG 엔진에 Agent Teams 위임 옵션 | `--use-teams` 플래그 |
| FR-9.2 | Team Lead가 태스크 분배 + 결과 통합 | 리드가 최종 결과 생성 |
| FR-9.3 | Teammate별 도구 제한 | 아키텍처: Read/Grep, 테스트: Write/Bash 등 |
| FR-9.4 | Teammate별 독립 컨텍스트 | 메인 컨텍스트 오염 없음 |

---

### FR-10: 인프라 데몬 분리

**우선순위**: P3 (Sprint 3)
**목적**: hooks/ 디렉토리의 관심사 분리

#### 3.10.1 현행 구조
```
hooks/
├── audit-log.js        (훅) ✅
├── gateway.js          (데몬) ❌ → services/
├── relay-supabase.js   (데몬) ❌ → services/
├── telegram-adapter.js (데몬) ❌ → services/
├── heartbeat.js        (데몬) ❌ → services/
├── orchestrator.js     (데몬) ❌ → services/
└── ...
```

#### 3.10.2 목표 구조
```
hooks/            (순수 훅만)
├── audit-log.js
├── session-init.js
├── skill-suggest.js
├── pre-compact.js
├── stop-check.js
├── context-engine.js
├── quality-gate.js
├── telemetry.js
├── token-budget.js
├── statusline.sh
└── lib/

services/         (인프라 데몬)
├── gateway.js
├── relay-supabase.js
├── telegram-adapter.js
├── heartbeat.js
└── orchestrator.js
```

#### 3.10.3 상세 요구사항

| ID | 요구사항 | 수락 기준 |
|----|----------|-----------|
| FR-10.1 | 5개 데몬을 services/ 디렉토리로 이동 | 기존 경로 참조 모두 업데이트 |
| FR-10.2 | `lib/paths.js`에 SERVICES_DIR 추가 | 새 디렉토리 경로 등록 |
| FR-10.3 | agent-engine.js의 참조 경로 업데이트 | 데몬 시작/중지 명령 정상 동작 |
| FR-10.4 | CLAUDE.md 디렉토리 구조 업데이트 | 새 구조 반영 |

---

## 4. 비기능 요구사항 (Non-Functional Requirements)

### NFR-1: 성능

| ID | 요구사항 | 수치 목표 | 측정 방법 |
|----|----------|-----------|-----------|
| NFR-1.1 | PostToolUse 훅 차단 시간 | **0ms** (async) | telemetry hook_latency_ms |
| NFR-1.2 | SessionStart 복원 시간 | **<50ms** | context-engine 로그 |
| NFR-1.3 | 스킬 추천 응답 시간 | **<10ms** | skill-suggest 훅 측정 |
| NFR-1.4 | Stop 판단 시간 (command tier) | **<20ms** | stop-check 훅 측정 |
| NFR-1.5 | cache.js 로드 시간 | **<1ms** | 벤치마크 |

### NFR-2: 안정성

| ID | 요구사항 | 수치 목표 |
|----|----------|-----------|
| NFR-2.1 | 훅 실패 시 세션 영향 | **0건** (graceful degradation) |
| NFR-2.2 | 메모리 사용량 증가율 | **<1MB/hour** (장기 실행) |
| NFR-2.3 | 파일 쓰기 실패 시 데이터 손실 | **0건** (버퍼 + 재시도) |
| NFR-2.4 | 동시 실행 안전성 | 경합 조건 **0건** |

### NFR-3: 보안

| ID | 요구사항 |
|----|----------|
| NFR-3.1 | OWASP Top 10 취약점 **0건** |
| NFR-3.2 | 커맨드 인젝션 **0건** |
| NFR-3.3 | 민감 정보 로그 유출 **0건** |
| NFR-3.4 | 사용자 입력은 모든 경우 새니타이징 |

### NFR-4: 호환성

| ID | 요구사항 |
|----|----------|
| NFR-4.1 | Claude Code 2026.03.07+ 호환 |
| NFR-4.2 | Node.js 20.x / 22.x 호환 |
| NFR-4.3 | 기존 48개 Legacy Commands 하위 호환 |
| NFR-4.4 | 기존 settings.json 형식 호환 |

### NFR-5: 관측 가능성

| ID | 요구사항 |
|----|----------|
| NFR-5.1 | 모든 훅 실행 시간 자동 기록 |
| NFR-5.2 | 주간 성능 리포트 자동 생성 |
| NFR-5.3 | StatusLine에 토큰 사용량 실시간 표시 |
| NFR-5.4 | 품질 게이트 결과 감사 로그 기록 |

---

## 5. 시스템 아키텍처

### 5.1 현행 아키텍처 (v6)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code CLI (Host)                                              │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐     │
│  │SessionStart│   │UserPrompt│   │PostToolUse│   │   Stop   │      │
│  │   (sync)  │    │  (sync)  │    │  (sync)  │    │  (sync)  │     │
│  └────┬──────┘    └────┬─────┘    └────┬──────┘    └────┬─────┘    │
│       │                │               │                │          │
│  ┌────▼──────┐    ┌────▼─────┐    ┌────▼──────┐    ┌────▼─────┐   │
│  │session-init│   │skill-    │    │audit-log  │    │stop-check│   │
│  │   .js     │    │suggest.js│    │   .js     │    │   .js    │   │
│  └───────────┘    └──────────┘    └───────────┘    └──────────┘   │
│       │                │               │                │          │
│       ▼                ▼               ▼                ▼          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Shared Libraries                          │  │
│  │  lib/paths.js  │  lib/utils.js  │  lib/cache.js             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│       │                                                            │
│       ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  v6 Modules                                                  │  │
│  │  telemetry.js │ token-budget.js │ context-engine.js          │  │
│  │  quality-gate.js │ agent-engine.js                           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│       │                                                            │
│       ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Infrastructure Daemons (혼재됨)                              │  │
│  │  gateway.js │ relay-supabase.js │ telegram-adapter.js        │  │
│  │  heartbeat.js │ orchestrator.js                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Storage                                                     │  │
│  │  logs/audit/*.jsonl │ logs/checkpoints/*.jsonl │ .tmp/*      │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 목표 아키텍처 (v7)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code CLI (Host) — v2026.03.07+                               │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐ │
│  │SessionStart│   │UserPrompt│   │PostToolUse│   │     Stop     │  │
│  │ command   │    │ command  │    │ async cmd │    │ cmd+prompt+  │  │
│  │           │    │          │    │ (0ms블록) │    │ agent (3tier)│  │
│  └────┬──────┘    └────┬─────┘    └────┬──────┘    └────┬────────┘ │
│       │                │               │                │          │
│  ┌────▼──────┐    ┌────▼─────┐    ┌────▼──────┐    ┌────▼─────┐   │
│  │session-init│   │skill-    │    │audit-log  │    │stop-check│   │
│  │+ctx-engine│    │suggest.js│    │   .js     │    │+quality  │   │
│  │(snapshot) │    │(cached)  │    │(async)    │    │gate+agent│   │
│  └───────────┘    └──────────┘    └───────────┘    └──────────┘   │
│       │                │               │                │          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Core Libraries (v7)                                         │  │
│  │  lib/paths.js │ lib/utils.js (async) │ lib/cache.js (TTL+LRU)│ │
│  └──────────────────────────────────────────────────────────────┘  │
│       │                                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Performance Modules (v6→v7)                                 │  │
│  │  telemetry.js (bounded) │ token-budget.js (1M)               │  │
│  │  context-engine.js │ quality-gate.js │ agent-engine.js       │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐    ┌─────────────────────────────────────────┐   │
│  │ Skills 2.0   │    │  services/ (분리됨)                      │   │
│  │ subagent격리 │    │  gateway │ relay │ telegram │ heartbeat │   │
│  │ 도구제한     │    │  orchestrator (Agent Teams)              │   │
│  │ 모델선택     │    └─────────────────────────────────────────┘   │
│  └──────────────┘                                                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Storage                                                     │  │
│  │  logs/audit/*.jsonl │ logs/checkpoints/*.jsonl               │  │
│  │  logs/telemetry/*.jsonl │ contexts/*.json │ .tmp/*           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  External (Optional)                                         │  │
│  │  HTTP Hook → Supabase │ Telegram Bot │ WebSocket Gateway     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 데이터 플로우

#### 5.3.1 세션 시작 플로우
```
Claude Code 시작
  → SessionStart 이벤트
    → session-init.js
      → context-engine.restoreSnapshot()     [캐시 히트: <1ms, 미스: ~15ms]
        → 스냅샷 있음: formatSnapshotContext() → systemMessage (~500 토큰)
        → 스냅샷 없음: 3-tier fallback (compact → checkpoint → context-save)
      → telemetry.recordContextRestore()
```

#### 5.3.2 도구 호출 플로우
```
도구 실행 완료
  → PostToolUse 이벤트 (async!)
    → audit-log.js (백그라운드)
      → cache.nextSeq()                      [인메모리, 0ms]
      → 감사 엔트리 생성
      → appendFileSync(audit.jsonl)
      → telemetry.recordToolCall()
      → telemetry.recordFileChange()         [Write/Edit만]
      → tokenBudget.recordTurn()
  → 즉시 다음 도구 실행 (차단 없음!)
```

#### 5.3.3 세션 종료 플로우
```
Claude "작업 완료" 판단
  → Stop 이벤트
    → Tier 1: stop-check.js (command)
      → 키워드 분석 (incomplete/completion 점수)
      → 결정적 → allow/continue 반환
      → 비결정적 → "ambiguous" 반환 → Tier 2로
    → Tier 2: prompt hook (AI 시맨틱 판단)
      → 트랜스크립트 기반 완료 여부 판단
      → 비결정적 → Tier 3로
    → Tier 3: agent hook (quality-gate 딥 분석)
      → git diff 분석
      → 린트/타입 체크
      → 민감 파일 감지
      → verdict: pass/fail
  → 통과 시:
    → context-engine.createSnapshot()        [스냅샷 저장]
    → telemetry.flush()                      [메트릭 기록]
    → 체크포인트 기록
    → 세션 종료
```

#### 5.3.4 컴팩션 플로우
```
컨텍스트 사용량 임계값 도달
  → PreCompact 이벤트
    → pre-compact.js
      → git 상태 캡처
      → 최근 감사 로그 20건
      → 이전 체크포인트
      → 마크다운 백업 (legacy)
      → context-engine.createSnapshot()      [구조화 JSON 스냅샷]
      → telemetry.recordCompaction()
      → tokenBudget.recordCompaction()       [토큰 추정치 리셋]
  → Claude Code 내부 컴팩션 실행
  → 다음 세션 시작 시 스냅샷에서 복원
```

---

## 6. 구현 계획

### 6.1 Sprint 구조

```
Sprint 1 (1-2일) ── 즉시 효과, 안정성
  ├── FR-1: Async audit-log
  ├── FR-2: 1M 토큰 지원
  ├── FR-3: 테스트 수정 (기존 5건)
  └── FR-4: 메모리 누수 수정

Sprint 2 (3-5일) ── 보안 + 품질
  ├── FR-5: 보안 취약점 수정
  ├── FR-3.4: 신규 테스트 50건
  ├── FR-6: Skills 2.0 전환 (5개)
  └── FR-7: 3-tier Stop hook

Sprint 3 (1-2주) ── 아키텍처
  ├── FR-8: HTTP hook 텔레메트리
  ├── FR-9: Agent Teams 오케스트레이터
  ├── FR-10: 인프라 데몬 분리
  └── Empty catch 정리 (91→<20)
```

### 6.2 Sprint 1 상세 태스크

| # | 태스크 | 파일 | LOC | 의존성 | 예상 시간 |
|---|--------|------|-----|--------|-----------|
| 1.1 | settings.json에 async PostToolUse 추가 | settings.json | 10 | 없음 | 5분 |
| 1.2 | token-budget.js 1M 환경변수 지원 | token-budget.js | 15 | 없음 | 10분 |
| 1.3 | token-budget.js 1M 적응형 임계값 | token-budget.js | 20 | 1.2 | 15분 |
| 1.4 | smart-approve 테스트 제거 | tests/run-all.js | -20 | 없음 | 5분 |
| 1.5 | SessionStore/gateway 의존성 skip | tests/run-all.js | 15 | 없음 | 10분 |
| 1.6 | telemetry.js 배열 크기 제한 | telemetry.js | 15 | 없음 | 10분 |
| 1.7 | utils.js _latestFileCache 크기 제한 | lib/utils.js | 10 | 없음 | 5분 |

**Sprint 1 총 LOC**: ~85 (변경) / ~20 (제거)

### 6.3 Sprint 2 상세 태스크

| # | 태스크 | 파일 | LOC | 의존성 | 예상 시간 |
|---|--------|------|-----|--------|-----------|
| 2.1 | telegram-adapter execSync→execFileSync | telegram-adapter.js | 40 | 없음 | 30분 |
| 2.2 | telegram-adapter 입력 검증 강화 | telegram-adapter.js | 20 | 2.1 | 15분 |
| 2.3 | v6 모듈 테스트 프레임워크 설정 | tests/v6-modules.test.js | 50 | 없음 | 20분 |
| 2.4 | cache.js 테스트 10개 | tests/v6-modules.test.js | 80 | 2.3 | 25분 |
| 2.5 | telemetry.js 테스트 10개 | tests/v6-modules.test.js | 80 | 2.3 | 25분 |
| 2.6 | token-budget.js 테스트 10개 | tests/v6-modules.test.js | 80 | 2.3 | 25분 |
| 2.7 | context-engine.js 테스트 10개 | tests/v6-modules.test.js | 80 | 2.3 | 25분 |
| 2.8 | quality-gate.js 테스트 10개 | tests/v6-modules.test.js | 80 | 2.3 | 25분 |
| 2.9 | Skills 2.0 메타데이터 추가 (5개) | skills/*/SKILL.md | 25 | 없음 | 15분 |
| 2.10 | settings.json 3-tier Stop 등록 | settings.json | 15 | 없음 | 10분 |
| 2.11 | stop-check.js ambiguous 반환 강화 | stop-check.js | 20 | 없음 | 15분 |

**Sprint 2 총 LOC**: ~570

### 6.4 Sprint 3 상세 태스크

| # | 태스크 | 파일 | LOC | 의존성 | 예상 시간 |
|---|--------|------|-----|--------|-----------|
| 3.1 | HTTP hook 텔레메트리 엔드포인트 | settings.json | 10 | 없음 | 10분 |
| 3.2 | Agent Teams 오케스트레이터 v2 | services/orchestrator-v2.js | 300 | 없음 | 2시간 |
| 3.3 | 데몬 파일 이동 (5개) | hooks/ → services/ | 0 | 없음 | 15분 |
| 3.4 | 참조 경로 업데이트 | lib/paths.js, agent-engine.js | 20 | 3.3 | 15분 |
| 3.5 | Empty catch 정리 (91→<20) | 전체 | 150 | 없음 | 1시간 |

**Sprint 3 총 LOC**: ~480

---

## 7. 영향 파일 목록 (Impact Analysis)

### 7.1 전체 변경 파일

| 파일 | Sprint | 작업 유형 | 변경 범위 |
|------|--------|-----------|-----------|
| `/root/.claude/settings.json` | 1, 2 | 수정 | 훅 등록 추가 |
| `/root/.claude/hooks/token-budget.js` | 1 | 수정 | 1M 지원 + 임계값 |
| `/root/.claude/hooks/telemetry.js` | 1 | 수정 | 메모리 제한 추가 |
| `/root/.claude/hooks/lib/utils.js` | 1 | 수정 | 캐시 크기 제한 |
| `/home/user/claude-agent-system/tests/run-all.js` | 1 | 수정 | 깨진 테스트 수정 |
| `/home/user/claude-agent-system/tests/v6-modules.test.js` | 2 | **신규** | 50개 테스트 |
| `/root/.claude/hooks/telegram-adapter.js` | 2 | 수정 | 보안 수정 |
| `/root/.claude/hooks/stop-check.js` | 2 | 수정 | ambiguous 강화 |
| `skills/reviewing-code/SKILL.md` | 2 | 수정 | Skills 2.0 메타 |
| `skills/debugging-errors/SKILL.md` | 2 | 수정 | Skills 2.0 메타 |
| `skills/checking-status/SKILL.md` | 2 | 수정 | Skills 2.0 메타 |
| `skills/logging-session/SKILL.md` | 2 | 수정 | Skills 2.0 메타 |
| `skills/scanning-security/SKILL.md` | 2 | 수정 | Skills 2.0 메타 |
| `services/orchestrator-v2.js` | 3 | **신규** | Agent Teams |
| `/root/.claude/hooks/lib/paths.js` | 3 | 수정 | SERVICES_DIR 추가 |
| `CLAUDE.md` | 3 | 수정 | 디렉토리 구조 업데이트 |

### 7.2 변경 없는 파일 (영향 없음 확인)

- `session-init.js` — Sprint 1-2에서 변경 불필요 (이미 context-engine 통합)
- `pre-compact.js` — 변경 불필요 (이미 v6에서 스냅샷 지원)
- `skill-suggest.js` — 변경 불필요 (이미 캐시 통합)
- `audit-log.js` — 변경 불필요 (async는 settings.json만으로 적용)
- `agent-engine.js` — Sprint 3에서만 경로 참조 수정

---

## 8. 위험 관리 (Risk Management)

### 8.1 기술 위험

| # | 위험 | 확률 | 영향 | 완화 방안 |
|---|------|------|------|-----------|
| R1 | async 훅에서 감사 로그 유실 | 중간 | 높음 | 로컬 버퍼 + 재시도 로직 |
| R2 | 1M 컨텍스트 beta 불안정 | 낮음 | 중간 | 환경변수로 opt-in, 기본은 200K |
| R3 | execFileSync 호환성 문제 | 낮음 | 높음 | execSync 폴백 유지 |
| R4 | 테스트 환경과 프로덕션 차이 | 중간 | 중간 | CI 파이프라인 구축 (향후) |
| R5 | Agent Teams API 변경 | 중간 | 높음 | 기존 DAG 엔진 폴백 유지 |

### 8.2 일정 위험

| # | 위험 | 완화 방안 |
|---|------|-----------|
| S1 | Sprint 2 보안 수정 시간 초과 | telegram-adapter.js가 26KB — 영향 범위 제한 필요 |
| S2 | 테스트 50건 작성 시간 | 모듈당 10건으로 제한, 핵심 경로만 |
| S3 | Sprint 3 Agent Teams 복잡도 | MVP로 시작, 점진적 확장 |

### 8.3 롤백 전략

| Sprint | 롤백 방법 |
|--------|-----------|
| Sprint 1 | settings.json에서 async 제거, token-budget 하드코딩 복원 |
| Sprint 2 | 보안 수정은 롤백 불가 (롤백=취약점 복원), 테스트는 삭제만 |
| Sprint 3 | services/ → hooks/ 복원, Agent Teams는 기존 DAG 폴백 |

---

## 9. 검증 계획 (Verification)

### 9.1 자동 검증

| 단계 | 명령어 | 기대 결과 |
|------|--------|-----------|
| 유닛 테스트 | `node tests/run-all.js` | 0 failures |
| v6 모듈 테스트 | `node tests/v6-modules.test.js` | 50/50 pass |
| 훅 벤치마크 | `node hooks/telemetry.js benchmark-hooks` | avg <5ms |
| 텔레메트리 리포트 | `node hooks/telemetry.js weekly-report` | 출력 확인 |
| 토큰 버짓 | `node hooks/token-budget.js status` | JSON 출력 |
| 보안 스캔 | `grep -rn 'execSync.*\$\{' hooks/` | 0 matches |

### 9.2 수동 검증

| # | 시나리오 | 기대 결과 | Sprint |
|---|----------|-----------|--------|
| V1 | 세션 시작 → 도구 10회 사용 → 감사 로그 확인 | 10건 비동기 기록 | 1 |
| V2 | `CLAUDE_CONTEXT_1M=1` → StatusLine 확인 | 1M 기준 프로그레스 바 | 1 |
| V3 | 장기 세션 (1시간) → 메모리 확인 | hookLatencies ≤ 1000건 | 1 |
| V4 | Telegram 메시지 전송 `$(id)` | 인젝션 차단 | 2 |
| V5 | /review 스킬 호출 → 컨텍스트 확인 | subagent 격리 | 2 |
| V6 | 코드 변경 후 세션 종료 → quality-gate | 린트 체크 실행 | 2 |
| V7 | HTTP hook 텔레메트리 전송 | Supabase에 데이터 도착 | 3 |

### 9.3 성공 기준 체크리스트

| KPI | Sprint 1 후 | Sprint 2 후 | Sprint 3 후 |
|-----|-------------|-------------|-------------|
| 훅 차단 시간 | ✅ 0ms (async) | - | - |
| 컨텍스트 | ✅ 1M 지원 | - | - |
| 테스트 통과 | ✅ 100% (기존) | ✅ 100% (+50) | - |
| 보안 취약점 | - | ✅ 0 CRITICAL | - |
| 메모리 누수 | ✅ 0건 | - | - |
| 종합 점수 | 6.2/10 | 6.8/10 | **7.7/10** |

---

## 10. 부록

### 10.1 용어 사전

| 용어 | 정의 |
|------|------|
| **Hook** | Claude Code CLI가 특정 이벤트에서 실행하는 확장 포인트 |
| **Async Hook** | 비차단 훅 — stdout이 무시됨, 백그라운드 실행 |
| **HTTP Hook** | URL로 HTTP 요청을 보내는 훅 타입 |
| **Prompt Hook** | AI가 프롬프트를 평가하여 systemMessage를 반환하는 훅 |
| **Agent Hook** | 독립 에이전트가 도구를 사용하여 분석하는 훅 |
| **Skills 2.0** | SKILL.md 기반 스킬 정의 + subagent 격리/도구 제한/모델 선택 |
| **Agent Teams** | Team Lead + Teammates로 구성된 병렬 에이전트 그룹 |
| **Compaction** | Claude Code가 컨텍스트 윈도우 초과 시 수행하는 요약 압축 |
| **Burn Rate** | 분당 토큰 소비량 (tokens/minute) |
| **Quality Gate** | 세션 종료 전 코드 품질 자동 검증 단계 |
| **Structured Snapshot** | JSON 형식의 구조화된 컨텍스트 스냅샷 (컴팩션 손실 방지) |

### 10.2 참고 문서

| 문서 | 위치 |
|------|------|
| 경쟁 분석 보고서 | `docs/competitive-analysis-and-self-assessment.md` |
| v7 아키텍처 제안서 | `docs/architecture-upgrade-proposal.md` |
| v6 설계 계획 | Plan file (idempotent-stirring-storm.md) |
| Claude Code 공식 문서 | https://code.claude.com/docs/en/hooks |
| Skills 2.0 가이드 | Skills 2.0 Medium article |

### 10.3 변경 이력

| 버전 | 날짜 | 변경 내용 |
|------|------|-----------|
| 1.0 | 2026-03-11 | 초안 작성 |

---

## 승인

| 역할 | 이름 | 날짜 | 서명 |
|------|------|------|------|
| 제품 소유자 | | | |
| 기술 리드 | | | |
| 보안 검토 | | | |
