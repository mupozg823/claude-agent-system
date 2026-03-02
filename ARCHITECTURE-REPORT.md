# Claude Agent System v3 - 아키텍처 분석 보고서

> 분석일: 2026-02-28 | 분석 대상: claude-agent-system 전체

---

## 1. 프로젝트 개요

Claude Code의 자율 운영 에이전트 시스템. Claude CLI 훅 파이프라인을 중심으로 보안 자동승인, 감사 로깅, 세션 관리, 오케스트레이션, 원격 모니터링을 통합하는 OpenClaw급 제어 평면 시스템.

### 기술 스택
- **Runtime**: Node.js (v24)
- **의존성**: `@supabase/supabase-js ^2.98.0`, `playwright ^1.58.2`, `ws` (gateway)
- **프론트엔드**: Vanilla JS + Canvas 2D (로컬), Pixi.js v8 + Supabase Realtime (원격)
- **프로토콜**: WebSocket JSON Frame, SSE, Supabase Broadcast

---

## 2. 디렉토리 구조 (스캐폴딩)

```
claude-agent-system/
├── CLAUDE.md                  # 시스템 설정 문서 (운영 원칙, 스킬 카탈로그)
├── HEARTBEAT.md               # 하트비트 체크리스트 설정
├── CRON.md                    # 크론 작업 정의
├── package.json               # 의존성 (supabase-js, playwright)
├── settings.json              # Claude Code 권한/훅 바인딩 설정
├── dashboard.html             # 로컬 모니터링 대시보드 (Canvas 2D, SSE)
├── dashboard-remote.html      # 원격 모니터링 대시보드 (Pixi.js, Supabase)
│
├── hooks/                     # 핵심 훅 스크립트 (6,148 LOC)
│   ├── session-init.js        # [SessionStart] 3-tier 컨텍스트 복원 (133L)
│   ├── skill-suggest.js       # [UserPromptSubmit] 스킬 자동 추천 (112L)
│   ├── smart-approve.js       # [PreToolUse] 보안 자동승인 v3.1 (309L)
│   ├── audit-log.js           # [PostToolUse] JSONL 감사 로깅 v4 (138L)
│   ├── stop-check.js          # [Stop] 미완료 감지 + 체크포인트 (193L)
│   ├── agent-engine.js        # 코어 엔진 (큐/체크포인트/Lane/DAG) (594L)
│   ├── orchestrator.js        # DAG 오케스트레이션 엔진 (826L)
│   ├── gateway.js             # WebSocket 제어 평면 (1,486L) ★최대 파일
│   ├── relay-supabase.js      # Supabase Realtime 릴레이 (841L)
│   ├── heartbeat.js           # 하트비트 데몬 (205L)
│   ├── skill-router.js        # 스킬 라우팅 브릿지 (324L)
│   ├── dashboard-server.js    # 로컬 대시보드 HTTP/SSE 서버 (423L)
│   ├── tunnel.js              # ngrok/localtunnel 터널링 (300L)
│   ├── supabase-auto-setup.js # 원클릭 Supabase 셋업 (264L)
│   ├── session-init.sh        # (레거시) 세션 초기화 쉘 스크립트
│   ├── auto-log.sh            # (레거시) 자동 로깅 쉘 스크립트
│   ├── skill-rules.json       # 스킬 매칭 규칙 (키워드/패턴/우선순위)
│   └── binding-rules.json     # Gateway 바인딩 규칙
│
├── commands/                  # 48개 스킬 정의 (.md 파일)
│   ├── log.md, continue.md, status.md, optimize.md ...
│   ├── review.md, fix-all.md, t-refactor.md ...
│   ├── w-feature-dev.md, w-smart-fix.md, w-tdd-cycle.md ...
│   └── orchestrate.md
│
├── plugins/                   # 플러그인 데이터
│   ├── known_marketplaces.json
│   ├── install-counts-cache.json
│   └── blocklist.json
│
└── logs/                      # 세션/오케스트레이션 로그
    ├── session-*.md
    └── orch-run-*.md
```

---

## 3. 아키텍처 다이어그램

### 3.1 전체 시스템 아키텍처

```
╔════════════════════════════════════════════════════════════════════════╗
║                    Claude Agent System v3 Architecture                ║
╠════════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ┌──────────────────────── Claude CLI Session ─────────────────────┐  ║
║  │                                                                 │  ║
║  │  [SessionStart]──→ session-init.js ──→ 3-tier 컨텍스트 주입     │  ║
║  │       │              (checkpoint → context → log → queue)       │  ║
║  │       ▼                                                         │  ║
║  │  [UserPrompt]───→ skill-suggest.js ──→ 스킬 추천 systemMessage  │  ║
║  │       │              (skill-rules.json 패턴 매칭)               │  ║
║  │       ▼                                                         │  ║
║  │  [PreToolUse]───→ smart-approve.js ──→ allow/deny 결정          │  ║
║  │       │              (BLOCK → INDIRECT → PIPE → SAFE → allow)   │  ║
║  │       ▼                                                         │  ║
║  │  [도구 실행] ◀──── settings.json 권한 관리                       │  ║
║  │       │                                                         │  ║
║  │       ▼                                                         │  ║
║  │  [PostToolUse]──→ audit-log.js ──→ JSONL 감사 기록              │  ║
║  │       │              (그룹분류, 순서번호, 에러추출, 민감경로)       │  ║
║  │       ▼                                                         │  ║
║  │  [Stop]─────────→ stop-check.js ──→ 미완료 감지 + 체크포인트    │  ║
║  │                     (가중치 분석: incScore vs compScore)          │  ║
║  └─────────────────────────────────────────────────────────────────┘  ║
║                              │                                       ║
║                   ┌──────────┼──────────┐                            ║
║                   ▼          ▼          ▼                            ║
║  ┌─────────────────┐ ┌────────────┐ ┌────────────────┐              ║
║  │  agent-engine   │ │orchestrator│ │  gateway.js    │              ║
║  │ (코어 엔진)      │ │ (DAG 실행)  │ │ (WebSocket)    │              ║
║  │                 │ │            │ │                │              ║
║  │ • checkpoint    │ │ • FSM 상태  │ │ • JSON Frame   │              ║
║  │ • queue (JSONL) │ │ • pipeline │ │ • InboundGuard │              ║
║  │ • lane queue    │ │ • claude -p│ │ • RateLimiter  │              ║
║  │ • global conc.  │ │ • 스킬 라우트│ │ • BindingRules│              ║
║  │ • metrics       │ │ • 재시도    │ │ • AuditTailer  │              ║
║  │ • DAG save      │ │ • 리포트   │ │ • SteerMode    │              ║
║  │ • cleanup       │ │            │ │ • Webhook      │              ║
║  └────────┬────────┘ └─────┬──────┘ └───────┬────────┘              ║
║           │                │                │                        ║
║           ▼                ▼                ▼                        ║
║  ┌──────────────────── 저장소 계층 ────────────────────────┐         ║
║  │                                                         │         ║
║  │  logs/audit/audit-YYYY-MM-DD.jsonl   (감사 로그)         │         ║
║  │  logs/checkpoints/checkpoint-*.jsonl (체크포인트)         │         ║
║  │  queue/commands.jsonl                (명령 큐)           │         ║
║  │  queue/lanes/lane-*.jsonl            (세션별 Lane 큐)    │         ║
║  │  contexts/*.json                     (컨텍스트 저장)      │         ║
║  │  orchestrator/*.json                 (DAG 상태)          │         ║
║  │  logs/gateway.jsonl                  (Gateway 로그)      │         ║
║  └─────────────────────────────────────────────────────────┘         ║
║                              │                                       ║
║           ┌──────────────────┼──────────────────┐                    ║
║           ▼                  ▼                  ▼                    ║
║  ┌─────────────────┐ ┌────────────────┐ ┌────────────────────┐      ║
║  │ dashboard-server│ │relay-supabase  │ │   heartbeat.js     │      ║
║  │ (HTTP/SSE:17891)│ │ (Supabase RT)  │ │ (30min scheduler)  │      ║
║  │                 │ │                │ │                    │      ║
║  │ • SSE 스트리밍   │ │ • Broadcast    │ │ • cleanup 실행      │      ║
║  │ • REST API      │ │ • Presence     │ │ • queue 확인        │      ║
║  │ • QR 생성       │ │ • AuditTailer  │ │ • relay 재시작       │      ║
║  │ • 메트릭/타임라인 │ │ • Worker loop  │ │ • 상태 확인          │      ║
║  └────────┬────────┘ └───────┬────────┘ └────────────────────┘      ║
║           │                  │                                       ║
║           ▼                  ▼                                       ║
║  ┌─────────────────┐ ┌────────────────────────────┐                  ║
║  │  dashboard.html │ │  dashboard-remote.html     │                  ║
║  │  (로컬 Canvas)   │ │  (원격 Pixi.js + Supabase) │                  ║
║  │                 │ │  (Vercel 배포)              │                  ║
║  └─────────────────┘ └────────────────────────────┘                  ║
║                                                                      ║
║  ┌─────────── 보조 모듈 ──────────────────────────────────────────┐  ║
║  │  tunnel.js          - ngrok/localtunnel 외부 노출               │  ║
║  │  supabase-auto-setup.js - 웹 기반 Supabase 원클릭 셋업         │  ║
║  │  skill-router.js    - 스킬 명칭↔명령 라우팅 브릿지              │  ║
║  │  session-init.sh    - (레거시) 세션 초기화 쉘                   │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
╚════════════════════════════════════════════════════════════════════════╝
```

### 3.2 훅 파이프라인 상세 흐름

```
Session Start ──→ session-init.js
                   │
                   ├─ 1) checkpoint: 최신 checkpoint-*.jsonl → 24h 이내
                   ├─ 2) context-save: 최신 contexts/*.json → 48h 이내
                   ├─ 3) session-log: logs/*.md → "다음에 이어서 할 작업" 섹션
                   └─ 4) queue: queue/commands.jsonl → pending 항목
                   │
                   ▼ additionalContext 주입

User Prompt ────→ skill-suggest.js
                   │
                   ├─ skill-rules.json 로드 (48개 스킬)
                   ├─ 키워드 매칭 (+15점) + 패턴 매칭 (+25점)
                   ├─ 카테고리 부스트 + 우선순위 반영
                   └─ 상위 3개 추천 → systemMessage
                   │
                   ▼

PreToolUse ─────→ smart-approve.js
                   │
                   ├─ [Write/Edit] → 민감 파일 체크 (SENSITIVE_PATHS)
                   │                  .env, credentials, .pem, .key, id_rsa ...
                   │                  → 민감: deny / 비민감: allow
                   │
                   └─ [Bash] → 5단계 필터링:
                       ├─ 1) BLOCK 패턴 (rm -rf, force push, DROP, shutdown...)
                       ├─ 2) INDIRECT_DANGER (eval+rm, exec+dd, $()...)
                       ├─ 3) 파이프 우측 분석 (cmd | dangerous_cmd)
                       ├─ 4) SAFE 패턴 (git, npm, node, python, curl...)
                       │     + extractEffectiveCommand (cd && cmd 지원)
                       └─ 5) 미분류 → 경고 로그 + allow
                   │
                   ▼

Tool Execute ───→ [Claude Code 도구 실행]
                   │
                   ▼

PostToolUse ────→ audit-log.js
                   │
                   ├─ 도구 그룹 분류 (shell/file-io/search/external/agent/edit)
                   ├─ 순서 번호 (seq) 관리 (.seq 파일)
                   ├─ 요약 생성 (도구별 맞춤 500자)
                   ├─ 에러 스택트레이스 추출 (300자)
                   ├─ 민감 경로 경고
                   └─ audit-YYYY-MM-DD.jsonl 기록
                   │
                   ▼

Stop ───────────→ stop-check.js
                   │
                   ├─ stop_hook_active=true → 즉시 허용 (무한루프 방지)
                   ├─ 가중치 기반 미완료 분석:
                   │   ├─ incPatterns: "계속 진행"(+3), "남은 작업"(+3), "in_progress"(+2)
                   │   └─ compPatterns: "모든 작업 완료"(+5), "완료했습니다"(+4)
                   ├─ 대기 큐 확인 → log₂(count+1) * 2 점 추가
                   ├─ shouldBlock = (incScore ≥ 4) && (compScore < incScore)
                   │   → true: 체크포인트 기록 + block 반환
                   │   → false: 정상 종료 + 세션 마커 + cleanup
                   └─ cleanup: 7일 마커, 30일 감사로그, 14일 체크포인트 삭제
```

### 3.3 데이터 흐름 다이어그램

```
┌─────────┐     ┌──────────┐     ┌──────────────┐     ┌─────────────┐
│ Claude   │────→│ Hooks    │────→│ JSONL Storage │────→│ Dashboard   │
│ CLI      │     │ Pipeline │     │              │     │ (SSE/WS)    │
│ Session  │     │          │     │ audit-*.jsonl│     │             │
└─────────┘     └──────────┘     │ checkpoint-* │     └──────┬──────┘
                                 │ commands.jsonl│            │
                                 │ lane-*.jsonl  │            │
                                 └──────┬───────┘            │
                                        │                    │
                    ┌───────────────────┼────────────────────┘
                    │                   │
              ┌─────▼─────┐     ┌──────▼──────┐
              │ Relay      │     │ Gateway     │
              │ (Supabase) │     │ (WebSocket) │
              └─────┬──────┘     └──────┬──────┘
                    │                   │
              ┌─────▼──────────────────▼──────┐
              │    Remote Dashboard (Vercel)    │
              │    Mobile/Web Clients           │
              └────────────────────────────────┘
```

### 3.4 Gateway 내부 아키텍처

```
                     ┌─── Gateway :18790 ───┐
                     │                      │
  WebSocket Client ──┤  InboundGuard        │
  Supabase Relay ────┤   ├─ Dedup (60s TTL) │
  CLI (--status) ────┤   └─ Debounce (300ms)│
  Webhook (HTTP) ────┤                      │
                     │  BindingRuleEngine   │
                     │   └─ Match → Handler │
                     │                      │
                     │  RateLimiter          │
                     │   └─ Token Bucket    │
                     │                      │
                     │  SessionStore        │
                     │   └─ In-memory + disk│
                     │                      │
                     │  CommandExecutor     │
                     │   ├─ skill-router.js │
                     │   ├─ agent-engine.js │
                     │   └─ claude -p       │
                     │                      │
                     │  AuditTailer         │
                     │   └─ fs.watch + poll │
                     │                      │
                     │  SteerMode           │
                     │   └─ 실행 중 방향전환  │
                     └──────────────────────┘
```

---

## 4. 모듈별 상세 분석

### 4.1 핵심 모듈 요약

| 모듈 | 라인수 | 역할 | 상태 |
|------|--------|------|------|
| gateway.js | 1,486L | WebSocket 제어 평면 (가장 복잡) | 기능 완전, `ws` 외부 의존 |
| orchestrator.js | 826L | FSM 기반 DAG 오케스트레이션 | `claude -p` 실행 의존 |
| relay-supabase.js | 841L | Supabase Realtime 릴레이 | `@supabase/supabase-js` 의존 |
| agent-engine.js | 594L | 코어 엔진 (큐/체크포인트/Lane) | 순수 Node.js (외부 의존 없음) |
| dashboard-server.js | 423L | HTTP + SSE 서버 | 순수 Node.js |
| skill-router.js | 324L | 스킬↔명령 라우팅 | 라이브러리 역할 |
| smart-approve.js | 309L | 보안 자동승인 | 훅 전용 |
| tunnel.js | 300L | 외부 터널링 | ngrok/localtunnel 의존 |
| supabase-auto-setup.js | 264L | 원클릭 셋업 웹 UI | 독립 실행 |
| heartbeat.js | 205L | 주기 실행 데몬 | Windows schtasks 의존 |
| stop-check.js | 193L | 중단 방지 | 훅 전용 |
| audit-log.js | 138L | 감사 로깅 | 훅 전용 |
| session-init.js | 133L | 세션 초기화 | 훅 전용 |
| skill-suggest.js | 112L | 스킬 추천 | 훅 전용 |

### 4.2 대시보드 비교

| 구분 | dashboard.html (로컬) | dashboard-remote.html (원격) |
|------|----------------------|------------------------------|
| 렌더러 | Canvas 2D | Pixi.js v8 (WebGL) |
| 백엔드 | SSE + REST API | Supabase Realtime Broadcast |
| 배포 | 로컬 (origin-relative) | Vercel (클라우드) |
| 인증 | URL Token | Supabase anon key + Session |
| 파일 크기 | 56KB (1,281L) | 121KB (2,518L) |
| 모바일 | 반응형 | 모바일 퍼스트 + PWA |
| 특징 | 기본 모니터링 | 명령 전송, Presence, 고급 UI |

---

## 5. 발견된 이슈 및 개선 사항

### 5.1 치명적 이슈 (Critical)

#### C1. `__filename` 오타 - relay-supabase.js:512
```javascript
// 현재 코드 (오류)
const ORCHESTRATOR = path.join(path.dirname(__filename), 'orchestrator.js');

// 수정 필요
const ORCHESTRATOR = path.join(path.dirname(__filename), 'orchestrator.js');
// 또는 (이미 상단에 정의되어 있다면 그것을 사용)
```
**문제**: `__filename`은 Node.js 전역 변수이지만, 이 맥락에서는 파일 상단에서 별도 import 없이 사용. ESM 모드가 아니므로 CJS에서는 정상 동작하나, `__filename`의 `__`가 아닌 다른 변수명이 사용될 가능성 확인 필요. 실제로는 정상 동작하지만, 상단의 `const HOOKS_DIR` 패턴과 불일치.

#### C2. `ws` 모듈 미선언 - gateway.js:34
```javascript
const WebSocket = require('ws');
```
**문제**: `package.json`에 `ws`가 dependencies에 없음. `npm install`만으로는 `ws` 모듈이 설치되지 않아 gateway.js가 실행 불가.
```json
// package.json에 누락:
"ws": "^8.x"
```

#### C3. `playwright` 불필요 의존성
```json
"playwright": "^1.58.2"
```
**문제**: 프로젝트 어디에서도 `playwright`를 require/import하지 않음. 불필요한 대용량 의존성(~180MB+).

### 5.2 주요 이슈 (Major)

#### M1. `localDate()` 함수 6회 중복 구현

동일한 날짜 포맷팅 함수가 6개 파일에 독립적으로 구현됨:

| 파일 | 라인 |
|------|------|
| agent-engine.js | L38-41 |
| smart-approve.js | L27-30 |
| audit-log.js | L18-21 |
| stop-check.js | L23-27 (인라인) |
| relay-supabase.js | L281-284 |
| gateway.js | L66-69 |
| dashboard-server.js | L49-55 |

**개선**: 공유 유틸리티 모듈(`utils.js`)로 추출.

#### M2. 감사 로그 파일 경로 3회 중복 계산

`path.join(HOME, '.claude', 'logs', 'audit', `audit-${date}.jsonl`)` 패턴이 smart-approve.js, audit-log.js, stop-check.js, agent-engine.js, relay-supabase.js, dashboard-server.js, gateway.js 등 7곳에서 독립적으로 계산됨.

#### M3. 체크포인트 쓰기 로직 2회 중복

- `agent-engine.js:writeCheckpoint()` (L44-55)
- `stop-check.js:writeCheckpoint()` (L41-55)

거의 동일한 코드가 2곳에 독립 구현. `stop-check.js`는 agent-engine.js를 직접 호출(`node agent-engine.js checkpoint`)하지 않고 자체 구현 사용.

#### M4. `httpJson()` 함수 2회 중복

- `relay-supabase.js:httpJson()` (L77-102)
- `supabase-auto-setup.js:httpJson()` (L28-46)

동일한 HTTPS JSON 요청 유틸리티가 2곳에 독립 구현.

#### M5. 큐 파일 읽기 로직 4회 중복

`queue/commands.jsonl` 파일을 읽고 파싱하는 로직이 agent-engine.js, stop-check.js, dashboard-server.js, session-init.js에서 각각 독립 구현.

#### M6. 메트릭 계산 로직 3회 중복

ops/min, successRate, blockRate 등 메트릭 계산이:
- `agent-engine.js:getMetrics()` (L424-465)
- `dashboard-server.js:getMetrics()` (L115-153)
- `gateway.js` 내부

에서 각각 독립 구현. 결과 형태도 미묘하게 다름.

#### M7. 경로 하드코딩 문제

대부분의 파일이 `~/.claude/` 경로를 독립적으로 조합:
```javascript
const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = path.join(HOME, '.claude');
```
이 패턴이 모든 파일 상단에 반복됨. 프로젝트 자체 경로(`/home/user/claude-agent-system/`)와 `~/.claude/` 참조가 혼재.

### 5.3 보안 이슈 (Security)

#### S1. Supabase Anon Key 하드코딩 - dashboard-remote.html
```javascript
// dashboard-remote.html에 Supabase URL과 anon key가 평문 하드코딩
URL: https://cdiptfmagemjfmsuphaj.supabase.co
Key: eyJhbGciOiJIUzI1NiIs... (JWT, 만료: 2084년)
```
**위험도**: 중간 - anon key는 role-restricted이지만, 공개 배포 시 Broadcast 채널 스푸핑 가능.

#### S2. Relay 명령 실행 보안 - relay-supabase.js:694-696
```javascript
const result = execSync(item.command, {
  encoding: 'utf8', timeout: 30000, cwd: HOME,
});
```
**위험도**: 높음 - Lane Queue에서 가져온 명령을 `execSync`로 직접 실행. `isCommandAllowed()`가 있지만 allowlist가 너무 관대(`return true`가 기본).

#### S3. Gateway Webhook Secret 옵셔널
`loadWebhookSecret()`이 null 반환 시 서명 검증이 스킵될 수 있음.

### 5.4 설계 이슈 (Design)

#### D1. 역할 중첩: gateway.js vs relay-supabase.js

두 모듈 모두 다음 기능을 독립 구현:
- AuditTailer (감사 로그 테일링)
- Worker Loop (명령 실행)
- Status/Metrics 브로드캐스트
- Reconnect 로직

**차이점**: gateway는 WebSocket, relay는 Supabase Realtime. 그러나 내부 로직의 70%가 중복.

#### D2. 역할 중첩: agent-engine.js DAG vs orchestrator.js DAG

`agent-engine.js`에 `dagSave()`, `dagLoad()`, `dagList()`, `dagStatus()`가 있고, `orchestrator.js`에도 자체 `_checkpoint()` 시스템이 있음. 같은 `orchestrator/` 디렉토리에 저장하지만 상호 참조가 불완전.

#### D3. Heartbeat의 Windows 의존성

`heartbeat.js`의 `installScheduler()`가 `schtasks` (Windows Task Scheduler) 전용. CLAUDE.md에는 Linux도 지원한다고 명시하지만 crontab 지원 없음.

#### D4. 레거시 파일 잔존

- `session-init.sh` - session-init.js로 대체됨
- `auto-log.sh` - audit-log.js로 대체됨

settings.json에서는 .js 버전만 참조하므로 .sh 파일은 미사용.

### 5.5 코드 품질 이슈 (Quality)

#### Q1. 에러 핸들링 패턴: `catch {}` (빈 catch)

전체 코드베이스에서 40회 이상 빈 catch 블록 사용:
```javascript
try { ... } catch {}  // 에러 무시
```
디버깅 시 원인 추적이 극히 어려움. 최소한 `catch (e) { /* intentionally ignored */ }` 또는 경고 로그 권장.

#### Q2. 매직 넘버 다수

```javascript
300_000   // 5분 (stale lock timeout) - agent-engine.js
86400000  // 1일 (밀리초) - 여러 파일
60_000    // tick interval - relay-supabase.js
30_000    // status interval - relay-supabase.js
1500      // poll interval - relay-supabase.js
```
상수로 추출하여 의미 부여 필요.

#### Q3. 파일 I/O Race Condition 가능성

JSONL 파일에 대한 read-modify-write 패턴이 lock 없이 수행:
```javascript
// agent-engine.js:queueComplete
const lines = fs.readFileSync(file, ...).split('\n');
const updated = lines.map(...);
fs.writeFileSync(file, updated.join('\n'));
```
동시 실행 시 데이터 유실 가능. Lane Queue의 파일 기반 lock이 이를 완화하지만, 기본 queue에는 적용되지 않음.

---

## 6. 의존성 그래프

```
                    ┌─────────────┐
                    │ settings.json│◀── Claude CLI 설정 로드
                    └──────┬──────┘
                           │ hooks 참조
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
  session-init.js   smart-approve.js   audit-log.js
        │                                   │
        ▼                                   ▼
  ┌─────────────┐                    ┌──────────────┐
  │agent-engine │◀───────────────────│audit JSONL   │
  │    .js      │                    └──────────────┘
  └──────┬──────┘                           ▲
         │ require/execSync                 │ 파일 감시
         ▼                                  │
  ┌──────────────┐    ┌─────────────────────┤
  │orchestrator  │    │                     │
  │    .js       │    │    ┌────────────────┤
  └──────────────┘    │    │                │
         │            │    │                │
         ▼            ▼    ▼                │
  ┌────────────┐  ┌────────────┐   ┌───────┴──────┐
  │skill-router│  │  gateway   │   │relay-supabase│
  │    .js     │  │    .js     │   │    .js       │
  └────────────┘  └────────────┘   └──────────────┘
         │               │                │
         ▼               ▼                ▼
  ┌────────────┐  ┌────────────┐  ┌──────────────┐
  │skill-rules │  │binding-    │  │  Supabase    │
  │   .json    │  │rules.json  │  │  Cloud       │
  └────────────┘  └────────────┘  └──────────────┘

  외부 의존성:
  ┌──────────────────────────────────┐
  │ @supabase/supabase-js (relay)    │
  │ ws (gateway) ← package.json 누락!│
  │ playwright ← 미사용!             │
  └──────────────────────────────────┘
```

---

## 7. 개선 제안

### 7.1 즉시 수정 권장 (Quick Wins)

| # | 항목 | 영향도 | 난이도 |
|---|------|--------|--------|
| 1 | `ws` 모듈을 package.json에 추가 | 치명 | 쉬움 |
| 2 | `playwright` 의존성 제거 | 중간 | 쉬움 |
| 3 | `localDate()` 공유 유틸리티 추출 | 낮음 | 쉬움 |
| 4 | 레거시 .sh 파일 정리 | 낮음 | 쉬움 |
| 5 | dashboard-remote.html 하드코딩 키 제거 | 중간 | 중간 |

### 7.2 구조 개선 (리팩토링)

#### R1. 공유 유틸리티 모듈 추출
```
hooks/
├── lib/
│   ├── paths.js       # HOME, CLAUDE_DIR, AUDIT_DIR, 경로 상수
│   ├── date.js        # localDate(), toISODate() 등
│   ├── jsonl.js       # JSONL 읽기/쓰기/파싱 유틸
│   ├── http-client.js # httpJson() 공용 HTTP 클라이언트
│   └── audit.js       # 감사 로그 읽기/쓰기 공용
```

#### R2. Gateway와 Relay 통합
```
현재: gateway.js (1,486L) + relay-supabase.js (841L) = 2,327L
개선: gateway.js를 Channel Adapter 패턴으로 리팩토링
      ├── adapter/websocket.js   (WebSocket 채널)
      ├── adapter/supabase.js    (Supabase 채널)
      └── core/gateway-core.js   (공통 로직)
```

#### R3. Agent Engine을 라이브러리로 전환
현재 CLI 전용(`process.argv` 파싱)이면서 동시에 라이브러리로도 사용됨. 명확한 API 분리 필요:
```javascript
// 현재: execSync('node agent-engine.js checkpoint ...')
// 개선: const engine = require('./agent-engine');
//       engine.writeCheckpoint(summary, tasks);
```
이미 함수가 분리되어 있지만 `module.exports`가 없어 다른 모듈에서 직접 require 불가. 모든 곳에서 `execSync`로 CLI 호출 중.

#### R4. 에러 핸들링 표준화
```javascript
// 현재: catch {}
// 개선: catch (e) { log('warn', `Operation failed: ${e.message}`); }
// 또는: catch { /* expected when file doesn't exist */ }
```

### 7.3 아키텍처 개선 (중장기)

| # | 제안 | 효과 |
|---|------|------|
| A1 | JSONL → SQLite 전환 | Race condition 해결, 쿼리 성능 향상 |
| A2 | IPC 소켓으로 훅→엔진 통신 | execSync 오버헤드 제거 |
| A3 | TypeScript 전환 | 타입 안전성, IDE 지원 강화 |
| A4 | 테스트 코드 추가 | 현재 테스트 0건, 최소 핵심 로직 단위테스트 필요 |
| A5 | Heartbeat crontab 지원 | 크로스 플랫폼 호환성 |

---

## 8. 정량 분석 요약

```
┌──────────────────────────────────────────────────┐
│              코드베이스 통계                        │
├──────────────────────────────────────────────────┤
│  총 JavaScript 파일:      14개                    │
│  총 코드 라인:             6,148 LOC              │
│  평균 파일 크기:            439 LOC               │
│  최대 파일:                gateway.js (1,486L)     │
│  스킬 정의 파일:            48개 (.md)             │
│  외부 의존성:               2개 (+ 1 누락)         │
│                                                  │
│  중복 함수:                                       │
│    localDate()             7회                    │
│    경로 조합                7회                    │
│    httpJson()              2회                    │
│    writeCheckpoint()       2회                    │
│    메트릭 계산              3회                    │
│    큐 파일 읽기             4회                    │
│                                                  │
│  빈 catch 블록:            ~40회                   │
│  테스트 코드:               0건                    │
│  레거시 파일:               2개 (.sh)              │
├──────────────────────────────────────────────────┤
│  치명 이슈:     3건 (ws 누락, playwright, 명령실행) │
│  주요 이슈:     7건 (중복 로직)                     │
│  보안 이슈:     3건 (키 노출, 명령 실행)            │
│  설계 이슈:     4건 (역할 중첩)                     │
│  품질 이슈:     3건 (에러핸들링, 매직넘버, 레이스)    │
│  총 발견 이슈:  20건                               │
└──────────────────────────────────────────────────┘
```

---

## 9. 우선순위별 실행 로드맵

```
Phase 1 (즉시) ──→ ws 의존성 추가, playwright 제거, 레거시 정리
     │
Phase 2 (단기) ──→ 공유 유틸리티 추출, agent-engine exports 추가
     │
Phase 3 (중기) ──→ Gateway/Relay 통합, 에러 핸들링 표준화
     │
Phase 4 (장기) ──→ SQLite 전환, TypeScript, 테스트 추가
```

---

*이 보고서는 프로젝트의 현재 상태를 객관적으로 분석한 것이며, 시스템은 전체적으로 잘 설계된 자율 에이전트 아키텍처입니다. 훅 파이프라인, DAG 오케스트레이션, 원격 모니터링 등 고급 기능이 잘 통합되어 있으며, 위의 개선 사항을 적용하면 유지보수성과 안정성이 크게 향상될 것입니다.*
