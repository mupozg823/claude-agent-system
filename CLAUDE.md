# Claude Code - Autonomous Agent System v3

## 시스템
- Device: ASUS ROG Ally X (RC73XA) | AMD Z2 Extreme | 24GB | Win11 (26200)
- Shell: bash (Git Bash) | Node v24 | Python 3.12 | Git 2.53
- Editor: VS Code 1.109.5 | Package: npm, pip, winget

## 자율 운영 원칙
- **한국어로 대화**, 코드/로그는 영어 혼용 가능
- 승인 없이 자율 진행 (파괴적 작업만 확인: rm -rf, force push, DB drop)
- 막히면 **3가지 대안을 먼저 시도** 후 질문 (포기하지 않기)
- 작업 중 발견한 이슈는 즉시 수정
- 복잡한 작업은 TaskCreate로 추적, 완료 후 /log
- **작업이 끝날 때까지 멈추지 않기** (Stop 훅이 미완료 감지 + 체크포인트)

## 자율 에이전트 아키텍처 (v3)

### 훅 파이프라인
```
[SessionStart] → session-init.js: 3-tier 컨텍스트 복원 (체크포인트/컨텍스트/로그/큐)
[UserPrompt]   → skill-suggest.js: 프롬프트→스킬 자동 추천
[PreToolUse]   → smart-approve.js: Bash/Write/Edit 보안 분류
                  ├ 차단: 파괴 명령 + 간접 실행 + 파이프 위험 + 민감파일
                  ├ 자동승인: 안전 패턴 매칭
                  └ 통과: 미분류 (경고 로그)
[PostToolUse]  → audit-log.js: 전체 도구 JSONL 감사 (에러/민감경로 감지)
[Stop]         → stop-check.js: 가중치 기반 미완료 감지 + 자동 체크포인트
```

### 코어 엔진 (agent-engine.js)
```
node ~/.claude/hooks/agent-engine.js <command>
  checkpoint <summary> [tasks]  → 체크포인트 기록
  queue-add <command> [priority] → 명령 큐 추가 (레거시)
  queue-list [status]           → 대기 명령 조회
  queue-complete <id>           → 명령 완료 처리
  status                        → 시스템 상태 리포트
  metrics                       → 감사 로그 기반 메트릭
  cleanup                       → 오래된 파일 정리
  lane-add <session> <cmd> [p]  → Lane Queue 추가 (세션별)
  lane-next <session>           → 다음 명령 + 잠금 획득
  lane-complete <session> <id>  → 완료 + 잠금 해제
  lane-fail <session> <id>      → 실패 + 잠금 해제
  lane-stats <session>          → Lane 상태 조회
```

### Heartbeat 데몬
```
node ~/.claude/hooks/heartbeat.js             → 체크리스트 실행
node ~/.claude/hooks/heartbeat.js --install   → 30분 스케줄러 등록
node ~/.claude/hooks/heartbeat.js --status    → 상태 확인
설정: ~/.claude/HEARTBEAT.md (enabled/schedule/action)
```

### Gateway 제어 평면 (OpenClaw급)
```
[입력]                          [Gateway :18790]              [출력]
WebSocket 클라이언트              JSON Frame Protocol           Dashboard
Supabase Relay                   InboundGuard (dedup+debounce) Supabase Broadcast
CLI (--status/--stop)            PromiseQueue (Lane+Steer)     Audit Log
                                 CommandExecutor               Checkpoint
                                 AuditTailer (실시간 감시)
```
- 실행: `node ~/.claude/hooks/gateway.js` (데몬)
- 데몬: `node ~/.claude/hooks/gateway.js --daemon` (백그라운드)
- 상태: `node ~/.claude/hooks/gateway.js --status`
- 중지: `node ~/.claude/hooks/gateway.js --stop`
- 포트: `ws://127.0.0.1:18790` (HTTP health: `/health`, `/status`)
- PID: `~/.claude/gateway.pid`
- **Steer 모드**: 실행 중 방향 전환 (OpenClaw의 steer 패턴)

### 오케스트레이션 엔진 (orchestrator.js)
```
[목표 입력] → decompose (claude -p) → DAG 생성 → route (47 스킬) → execute → report
               ↓                        ↓                          ↓
          프로젝트 분석            병렬/직렬 실행              체크포인트 + 보고
```
- 실행: `node ~/.claude/hooks/orchestrator.js "목표" /프로젝트/경로`
- 재개: `Orchestrator.resume(runId)` (체크포인트 기반)
- 스킬: `/orchestrate` (48번째 스킬)
- 저장: `~/.claude/orchestrator/` (DAG + outbox)

### Supabase Realtime 릴레이 (원격 모니터링)
```
[CLI Host]                      [Supabase Cloud]              [Mobile/Web]
audit-log.js → JSONL             Channel "claude:{session}"    dashboard-remote.html
      ↓                               ↕                        (Vercel 배포)
relay-supabase.js (독립 데몬)    Broadcast: audit/status        Supabase JS SDK
 - poll+watch → broadcast        Broadcast: command/ack         - 카이로 UI 표시
 - subscribe → queue-add         Presence: online/offline       - 명령 전송 → 큐
 - 30초 status/metrics push
 - /orchestrate → orchestrator.js 호출
 - orchestrator outbox → broadcast
```
- 실행: `node ~/.claude/hooks/relay-supabase.js` (독립 데몬)
- 설정: `~/.claude/.supabase-config.json`
- 대시보드: `https://remote-dash-three.vercel.app` (카이로 게임즈 스타일)
- **`claude --remote` + relay 함께 사용** → 풀 액세스 + 실시간 모니터링

### 디렉토리 구조
```
~/.claude/
├── hooks/                    # 훅 스크립트
│   ├── session-init.js       # 세션 시작 (3-tier 컨텍스트)
│   ├── smart-approve.js      # 보안 자동승인 (v3)
│   ├── audit-log.js          # 감사 로깅 (v3)
│   ├── stop-check.js         # 중단 방지 + 체크포인트 (v3)
│   ├── agent-engine.js       # 코어 엔진 (큐/체크포인트/정리)
│   ├── heartbeat.js          # Heartbeat 데몬
│   ├── relay-supabase.js     # Supabase 릴레이 데몬
│   ├── gateway.js            # Gateway 제어 평면 (WebSocket :18790)
│   ├── orchestrator.js       # 자율 오케스트레이션 엔진 (DAG)
│   ├── skill-suggest.js      # 스킬 추천
│   └── skill-rules.json      # 추천 규칙
├── logs/
│   ├── audit/                # JSONL 감사 로그 (30일)
│   ├── checkpoints/          # 세션 체크포인트 (14일)
│   └── *.md                  # 세션 작업 로그
├── contexts/                 # 저장된 작업 컨텍스트
├── queue/                    # 명령 큐 (commands.jsonl)
├── orchestrator/             # 오케스트레이션 DAG + outbox
├── commands/                 # 48개 스킬 정의
├── HEARTBEAT.md             # 하트비트 체크리스트
├── CLAUDE.md                # 이 파일
├── .supabase-config.json    # Supabase 릴레이 설정
├── dashboard.html           # 로컬 모니터링 대시보드
├── dashboard-remote.html    # 원격 모니터링 (Vercel 배포)
└── settings.json            # 권한/훅 설정
```

### 차단 목록
rm -rf /, force push main/master, git reset --hard, DROP DB/TABLE, curl|sh, shutdown, npm publish, eval/exec 간접 위험, 파이프 우측 위험, 민감파일 쓰기(.env/credentials/ssh)

### 자동 승인
ls/cat/git/npm/node/python/eslint/docker/gh/schtasks/네트워크 진단, 모든 MCP 도구, 비민감 Write/Edit

### 감사 로그
- 위치: `~/.claude/logs/audit/audit-YYYY-MM-DD.jsonl`
- 30일 자동 정리, 에러/민감경로 경고 포함
- 대시보드: `~/.claude/dashboard.html`

## 도구 우선순위 (토큰 효율 + 속도)
1. **Serena 심볼릭** → 코드 탐색/수정 최우선 (get_symbols_overview → find_symbol → replace_symbol_body)
2. **MCP 적극 활용** → context7(최신 문서), grep-app(코드 검색), memory(지식 그래프), sequential-thinking(복잡 추론)
3. **Grep/Glob** → 파일 검색, 패턴 매칭
4. **Read (부분)** → offset/limit으로 필요한 줄만
5. **Read (전체)** → 최후 수단, 작은 파일만
6. **Task (병렬)** → 독립 작업은 반드시 병렬 에이전트로

## MCP 서버 활용
| 서버 | 용도 | 우선 사용 |
|------|------|-----------|
| Serena | 코드 심볼 탐색/수정 | 코드 작업 시 항상 |
| grep-app | 공개 저장소 코드 검색 | 외부 패턴 참고 시 |
| context7 | 라이브러리 최신 문서 | API 사용법 확인 시 |
| filesystem | 파일 시스템 조작 | 내장 도구 불가 시 |
| memory | 영구 지식 그래프 | 프로젝트 간 지식 공유 |
| sequential-thinking | 복잡한 추론 체인 | 아키텍처 설계 시 |
| Notion | 노션 페이지/DB 연동 | 문서 관리 요청 시 |

## 스킬 카탈로그 (48개)

### 세션/컨텍스트 (6)
/log, /continue, /status, /optimize, /context-save, /context-restore

### 프로젝트 (4)
/new-project, /deploy, /t-onboard, /api-scaffold

### 코드 품질 (7)
/review, /fix-all, /t-refactor, /t-tech-debt, /s-code-quality-checker, /code-explain, /legacy-modernize

### 디버깅/에러 (3)
/t-error-analysis, /t-smart-debug, /incident-response

### 보안 (3)
/t-security-scan, /w-security, /s-security-auditor

### 의존성 (3)
/t-deps-audit, /t-deps-upgrade, /s-dependency-upgrader

### 문서/보고 (3)
/t-doc-generate, /t-standup, /t-pr-enhance

### 워크플로우 (7)
/w-smart-fix, /w-feature-dev, /w-full-review, /w-git, /w-perf-optimize, /w-tdd-cycle, /code-migrate

### 사고/추론 (4)
/think-harder, /reflection, /eureka, /prompt-optimize

### 기획/리서치 (5)
/s-scope-decomposer, /s-story-executor, /s-task-creator, /s-best-practices-researcher, /s-standards-researcher

### 오케스트레이션 (1)
/orchestrate

### DevOps (1)
/docker-optimize

## 원격/헤드리스 모드
- `claude -p "작업"` → 비대화형 단일 작업 실행
- `claude -p "작업" --max-turns 50` → 최대 50턴 자율 실행
- `claude --remote` → 웹 원격 세션 시작
- `/rc` 또는 `/remote-control` → 세션 내에서 원격 제어 활성화
- Remote Control → 모바일에서 QR코드 스캔 → 전체 기능 접근

## Git 규칙
- autocrlf=true, longpaths=true, defaultBranch=main
- 커밋 메시지: 한글 또는 영어 (사용자 지시 따름)
- force push/reset --hard 전 반드시 확인
