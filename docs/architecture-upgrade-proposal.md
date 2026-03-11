# 아키텍처 업그레이드 제안서

> 2026-03-11 | 현행 v6 → 제안 v7
> 기준: Claude Code 최신 (2026.03.07), Skills 2.0, Agent Teams, HTTP Hooks

---

## 1. 현행 시스템 vs 최신 Claude Code 기능 갭 분석

### Claude Code 2026.03 신규 기능 (우리 시스템 미활용)

| 기능 | 출시 | 현행 활용 | 활용 가치 |
|------|------|-----------|-----------|
| **HTTP Hooks** | 2026.03.03 | ❌ 미사용 (전부 command 훅) | 🔴 높음 — 원격 검증, 팀 정책 |
| **Agent Teams** | 2026.02.05 | ❌ 미사용 | 🟡 중간 — 병렬 작업 오케스트레이션 |
| **Async Hooks** | 2026.01 | ❌ 미사용 | 🔴 높음 — audit-log 비차단 실행 |
| **Prompt Hooks** | stop-check에 부분 사용 | ⚠️ 제한적 | 🟡 중간 — 시맨틱 평가 |
| **Agent Hooks** | 사용 안함 | ❌ | 🟡 중간 — 딥 분석 |
| **Skills 2.0 통합** | 2025.10+ | ⚠️ 부분 (SKILL.md만) | 🔴 높음 — subagent 격리, 도구 제한 |
| `/loop` 명령어 | 2026.03 | ❌ | 🟡 — 반복 프롬프트 |
| `/simplify` `/batch` | 2026.03.03 | ❌ | 🟢 낮음 — 내장 명령어 |
| **Worktree 설정 공유** | 2026.03.03 | ❌ | 🟡 — 병렬 작업 시 설정 일관성 |
| **1M 토큰 컨텍스트** (beta) | 2026.02 | ❌ 200K 가정 | 🔴 높음 — 토큰 버짓 재계산 필요 |

### 현행 시스템의 구조적 제약

| 제약 | 원인 | 영향 |
|------|------|------|
| 모든 훅이 `command` 타입 | HTTP/async/prompt/agent 미사용 | 매 호출 프로세스 포크 (~42ms) |
| 단일 에이전트 | Agent Teams 미활용 | 복잡 작업 직렬 처리 |
| Skills 1.0 수준 | subagent 격리/도구 제한 미사용 | 스킬이 메인 컨텍스트 소비 |
| 토큰 버짓 200K 고정 | 1M 베타 미반영 | 불필요한 조기 컴팩션 |
| 인프라 데몬 hooks/에 혼재 | 분리 안됨 | 유지보수 복잡성 |

---

## 2. 객관적 개선 가능성 평가

### 실현 가능 (즉시, 1-2일)

| 개선 | 노력 | 효과 | 근거 |
|------|------|------|------|
| **audit-log → async hook** | 설정 1줄 | 훅 차단 시간 0ms | `"async": true` 추가만으로 적용 |
| **token-budget 1M 지원** | 10줄 수정 | 컴팩션 빈도 -80% | Opus 4.6 1M 컨텍스트 활용 |
| **HTTP hook 전환 (telemetry)** | 50줄 | 원격 텔레메트리 수집 | Supabase relay 불필요 |
| **깨진 테스트 수정** | 20줄 | 테스트 20/25 → 25/25 | smart-approve 참조 제거 |

### 실현 가능 (1주)

| 개선 | 노력 | 효과 | 근거 |
|------|------|------|------|
| **Skills 2.0 완전 전환** | 200줄 | 토큰 50% 절감 | subagent 격리로 메인 컨텍스트 보호 |
| **3-tier 훅 체계** | 100줄 | 판단 정확도 향상 | command(빠른체크)+prompt(시맨틱)+agent(딥분석) |
| **v6 모듈 테스트 50개** | 400줄 | 안정성 확보 | cache/telemetry/context-engine/quality-gate |
| **telegram-adapter 보안 수정** | 50줄 | CRITICAL 취약점 해소 | execSync → spawn + 입력 검증 |
| **메모리 누수 수정** | 30줄 | 장기 실행 안정성 | 배열/Map 상한 추가 |

### 실현 가능 (1개월)

| 개선 | 노력 | 효과 | 근거 |
|------|------|------|------|
| **Agent Teams 오케스트레이터** | 500줄 | 병렬 작업 속도 2-3배 | 기존 DAG 엔진 → Teams 위임 |
| **Plugin 패키징** | 300줄 | 배포/설치 간소화 | npm/npx 설치 경로 |
| **Empty catch 정리** | 200줄 | 디버깅 가능성 | 91개 → 20개 이하 |

### 실현 어려움 (근본 제약)

| 제약 | 이유 |
|------|------|
| 크로스 플랫폼 (Cursor/Codex) | 아키텍처 근본 재설계 필요, hooks API 다름 |
| 멀티모델 (100+ LLM) | Claude Code가 Claude 전용 |
| SWE-bench 벤치마크 | 에이전트 프레임워크 수준 작업 필요 |
| 자기 진화 스캐폴드 | LIVE-SWE-AGENT 수준 — 연구 수준 |

---

## 3. 제안 아키텍처 v7

### 3.1 Hook Pipeline v3 — 4-tier 훅 체계

```
현행 (v6):  command 훅만 사용 (프로세스 포크)
제안 (v7):  4-tier 혼합 훅

SessionStart  → command: session-init.js        (초기화)
UserPrompt    → command: skill-suggest.js        (빠른 매칭)
PreToolUse    → prompt: 위험 도구 시맨틱 검증     (신규)
PostToolUse   → async command: audit-log.js      (비차단!)
PreCompact    → command: pre-compact.js          (스냅샷)
Stop          → command: stop-check.js           (빠른 체크)
              → prompt: 애매한 경우 AI 판단       (기존)
              → agent: quality-gate 딥 분석       (신규)
StatusLine    → command: statusline.sh           (기존)
Notification  → http: telemetry endpoint         (신규)
```

**핵심 변경**: audit-log를 `async: true`로 전환하면 **매 도구 호출마다 42ms 절약**.

settings.json 변경 예시:
```json
{
  "hooks": {
    "PostToolUse": [{
      "type": "command",
      "command": "node ~/.claude/hooks/audit-log.js",
      "async": true
    }],
    "Stop": [
      { "type": "command", "command": "node ~/.claude/hooks/stop-check.js" },
      { "type": "prompt", "prompt": "세션이 완료되었는지 평가하세요..." },
      { "type": "agent", "prompt": "변경된 파일의 품질을 검증하세요...", "tools": ["Bash", "Read", "Grep"] }
    ]
  }
}
```

### 3.2 Skills 2.0 완전 전환

```
현행: SKILL.md → 메인 컨텍스트에 로드 (토큰 소비)
제안: SKILL.md + subagent 격리 + 도구 제한

skills/reviewing-code/SKILL.md:
---
name: reviewing-code
description: 종합 코드 리뷰
allowed_tools: [Read, Grep, Glob]     # 도구 제한 (Write 차단)
model: claude-sonnet-4-6              # 경량 모델
max_turns: 20                          # 턴 제한
subagent: true                         # 격리 실행
---
```

**효과**: 스킬 실행이 메인 컨텍스트를 소비하지 않음 → **토큰 50% 절감**.

### 3.3 Token Budget v2 — 1M 컨텍스트 지원

```javascript
// token-budget.js 수정
const MAX_CONTEXT_TOKENS = process.env.CLAUDE_CONTEXT_1M === '1'
  ? 1000000   // Opus 4.6 1M beta
  : 200000;   // Standard

// 적응형 임계값도 조정
if (MAX_CONTEXT_TOKENS >= 1000000) {
  // 1M 모드: 컴팩션 훨씬 늦게
  if (usedPct >= 95) action = 'compact-now';
  else if (usedPct >= 90) action = 'compact-soon';
}
```

**효과**: 1M 모드에서 컴팩션 빈도 **80% 감소**, 세션 길이 **5배**.

### 3.4 Agent Teams 연동 오케스트레이터

```
현행: orchestrator.js → DAG → execSync 서브프로세스 (100-300ms/step)
제안: orchestrator.js → DAG → Agent Teams (병렬, 격리)

예시: /orchestrate "feature 구현"
├─ Teammate 1: 아키텍처 분석 (Read, Grep)
├─ Teammate 2: 테스트 작성 (Write, Bash)
├─ Teammate 3: 구현 (Write, Edit, Bash)
└─ Lead: 통합 + 리뷰
```

**효과**: 복잡 작업 속도 **2-3배**, 각 에이전트 독립 컨텍스트.

### 3.5 HTTP Hook 기반 원격 텔레메트리

```
현행: telemetry.js → 로컬 JSONL 파일
     relay-supabase.js → 별도 데몬으로 Supabase 전송

제안: HTTP hook → 직접 Supabase/원격 엔드포인트 전송
```

settings.json:
```json
{
  "hooks": {
    "Notification": [{
      "type": "http",
      "url": "https://your-supabase.co/functions/v1/telemetry",
      "async": true
    }]
  }
}
```

**효과**: relay-supabase.js 데몬 **제거 가능**, 아키텍처 단순화.

---

## 4. 구현 로드맵

### Sprint 1 (1-2일) — 즉시 효과

| # | 작업 | 파일 | 효과 |
|---|------|------|------|
| 1 | audit-log async 전환 | settings.json | 매 호출 42ms 절약 |
| 2 | token-budget 1M 지원 | token-budget.js | 컴팩션 빈도 -80% |
| 3 | 깨진 테스트 수정 | tests/run-all.js | 25/25 통과 |
| 4 | 메모리 누수 수정 | telemetry.js, lib/utils.js | 장기 안정성 |

### Sprint 2 (3-5일) — 보안 + 품질

| # | 작업 | 파일 | 효과 |
|---|------|------|------|
| 5 | telegram-adapter 보안 | telegram-adapter.js | CRITICAL 해소 |
| 6 | v6 모듈 테스트 50개 | tests/v6-modules.test.js | 안정성 |
| 7 | 3-tier Stop 훅 | settings.json, stop-check.js | 판단 정확도 |
| 8 | Skills 2.0 전환 (주요 5개) | skills/*.md, settings.json | 토큰 절감 |

### Sprint 3 (1-2주) — 아키텍처

| # | 작업 | 파일 | 효과 |
|---|------|------|------|
| 9 | HTTP hook 텔레메트리 | settings.json | relay 데몬 제거 |
| 10 | empty catch 정리 | 전체 훅 파일 | 디버깅 가능 |
| 11 | 인프라 데몬 분리 | hooks/ → services/ | 관심사 분리 |
| 12 | Agent Teams 오케스트레이터 | orchestrator-v2.js | 병렬 2-3배 |

---

## 5. 기대 효과 종합

### 정량 목표

| 지표 | 현행 (v6) | 목표 (v7) | 개선율 |
|------|-----------|-----------|--------|
| 훅 차단 시간 | 42ms/call | **0ms** (async) | -100% |
| 토큰 효율 | 200K 기준 | **1M 기준** | 5배 |
| 스킬 토큰 소비 | 메인 컨텍스트 | **subagent 격리** | -50% |
| 컴팩션 빈도 | ~10회/세션 | **~2회/세션** | -80% |
| 보안 취약점 | 1 CRITICAL | **0** | 해소 |
| 테스트 | 20/25 통과 | **75/75 통과** | 3배 |
| Empty catch | 91개 | **<20개** | -78% |

### 점수 전망

| 차원 | 현행 | v7 목표 | 변화 |
|------|------|---------|------|
| 코드 품질 | 6 | **7.5** | +1.5 |
| 아키텍처 | 7 | **8.5** | +1.5 |
| 신뢰성 | 5 | **7** | +2 |
| 테스트 | 4 | **7** | +3 |
| 보안 | 5 | **7** | +2 |
| 성능 | 7 | **9** | +2 |
| 문서화 | 7 | **8** | +1 |
| **종합** | **5.7** | **7.7** | **+2.0** |

### ECC 대비 경쟁력

| 영역 | ECC | 우리 (v7 목표) | 평가 |
|------|-----|----------------|------|
| 스킬 수 | 854 | 97 | ❌ 격차 유지 |
| 보안 | AgentShield (1282 tests) | quality-gate + 보안 수정 | ⚠️ 축소 |
| 성능 | Hook 프로필 | async+1M+subagent | **✅ 우위** |
| 세션 지속성 | ❌ 없음 | **✅ 스냅샷+체크포인트** | **✅ 고유** |
| 원격 모니터링 | ❌ 없음 | **✅ HTTP hook+Telegram** | **✅ 고유** |
| 텔레메트리 | ❌ 없음 | **✅ 주간 리포트** | **✅ 고유** |
| 토큰 관리 | Hook 프로필 | **✅ 적응형 1M** | **✅ 우위** |
| 크로스 플랫폼 | 4개 플랫폼 | Claude만 | ❌ 격차 유지 |

---

## 6. 결론

### 객관적 판단

**실현 가능한가?** — **YES**, Sprint 1-2 (1주)만으로 종합 5.7 → **6.8** 달성 가능.
Sprint 3까지 (2주) 완료 시 **7.7** — ECC와 동등 수준.

**경쟁 이점이 있는가?** — **YES**, 3개 고유 영역:
1. 세션 체크포인트/복원 — 어떤 경쟁사에도 없음
2. HTTP hook 기반 원격 텔레메트리 — relay 데몬 제거, 아키텍처 단순화
3. 적응형 토큰 버짓 (1M 지원) — burn rate 기반 동적 컴팩션

**불가능한 것은?** — 크로스 플랫폼, 멀티모델, 자기 진화 스캐폴드는
현실적으로 1-2개월 내 불가능. Claude Code 전용 시스템으로 포지셔닝이 현실적.

### 최우선 실행 항목 (내일 바로)

1. `settings.json`에 `"async": true` 추가 → 즉시 42ms/call 절약
2. `token-budget.js`에 1M 컨텍스트 지원 → 컴팩션 빈도 -80%
3. `telegram-adapter.js` 보안 수정 → CRITICAL 해소
4. `tests/run-all.js` 깨진 테스트 수정 → 25/25 통과

---

## 출처

- [Claude Code Skills 2.0](https://medium.com/@richardhightower/claude-code-agent-skills-2-0-from-custom-instructions-to-programmable-agents-ab6e4563c176)
- [Claude Code Agent Teams Guide](https://claudefa.st/blog/guide/agents/agent-teams)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks: 12 Lifecycle Events](https://claudefa.st/blog/tools/hooks/hooks-guide)
- [Claude Code March 2026 Release](https://releasebot.io/updates/anthropic/claude-code)
- [Claude Code Extensions Explained](https://muneebsa.medium.com/claude-code-extensions-explained-skills-mcp-hooks-subagents-agent-teams-plugins-9294907e84ff)
- [Claude Code CLI Guide 2026](https://blakecrosley.com/guides/claude-code)
- [AI OS Blueprint](https://dev.to/jan_lucasandmann_bb9257c/claude-code-to-ai-os-blueprint-skills-hooks-agents-mcp-setup-in-2026-46gg)
- [Agent SDK Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [Claude Code Custom Subagents](https://code.claude.com/docs/en/sub-agents)
