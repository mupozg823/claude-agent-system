# ADR-001: Cross-Platform Bootstrap Architecture

**Status**: Accepted
**Date**: 2026-03-11
**Deciders**: System Architect
**Context**: v8 Hardening Phase

---

## Context

Claude Agent System은 두 가지 다른 환경에서 실행된다:

1. **데스크탑**: 영속적 파일시스템, `$HOME/.claude/` 유지됨
2. **모바일 (Claude Code Web)**: 일회성 컨테이너, 매 세션 `/home/user`에 레포만 clone됨

기존 설계는 데스크탑 전용이었다:
- settings.json이 `$HOME/.claude/hooks/` 경로의 hooks를 참조
- 하지만 hooks가 레포(`/home/user/claude-agent-system/hooks/`)에만 존재
- `$HOME/.claude/hooks/` 디렉토리 자체가 없음
- `npm install` 미실행으로 외부 의존성 없음
- 결과: 모바일에서 **Stop hook 1개만 작동**, 나머지 전체 미작동

## Decision

### SessionStart bootstrap.js 패턴 채택

```
SessionStart hook
  ↓
bootstrap.js (환경 감지)
  ├─ mobile?  → copy hooks/services to $HOME/.claude/
  ├─ desktop? → symlink hooks/services to $HOME/.claude/
  ├─ npm install (desktop only, hooks는 내장 모듈만 사용)
  ├─ settings.json merge (전체 hook chain 등록)
  └─ chain → session-init.js (기존 컨텍스트 복원)
```

### 핵심 설계 결정

**D1: 모바일에서 npm install 제거**
- hooks 24개 전부 Node.js 내장 모듈(fs, path, http, crypto)만 사용
- 외부 패키지(ws, supabase, sqlite, claude-sdk)는 services 전용
- services는 데스크탑 데몬이므로 모바일에서 불필요
- 절약: 10-30초 → 0초

**D2: 데스크탑은 symlink, 모바일은 copy**
- 데스크탑: 레포 수정 → 즉시 반영 (개발 편의)
- 모바일: 컨테이너가 ephemeral이므로 copy도 무방 (524KB, ~50ms)

**D3: settings.json 단방향 동기화 (레포 → 활성)**
- 레포의 settings.json이 single source of truth
- bootstrap가 활성 settings를 매번 덮어씀
- 양방향 sync는 충돌 위험 → 채택 안 함

**D4: Bootstrap이 session-init을 체인 호출**
- SessionStart hook은 1개만 등록 (bootstrap)
- bootstrap 완료 후 session-init.js를 child_process로 실행
- 기존 컨텍스트 복원 로직 변경 없음

## Alternatives Considered

### A1: CLAUDE.md에 "npm install && deploy 실행" 지시
- **기각**: 매 세션 LLM이 해석 → 비결정적, 토큰 낭비

### A2: Git clone hook으로 post-checkout 자동 설치
- **기각**: 모바일 환경에서 git hooks 미지원

### A3: 모든 의존성을 vendor/ 디렉토리에 번들
- **기각**: 117MB node_modules를 레포에 넣는 것은 비현실적
- hooks가 내장 모듈만 쓰므로 불필요

### A4: 모바일에서도 npm install 실행
- **기각**: 10-30초 오버헤드, hooks에 불필요한 패키지

## Consequences

### Positive
- 모바일/데스크탑 동일한 hook chain 작동
- 부트스트랩 ~150ms (모바일), ~50ms (데스크탑 2회차)
- settings.json 드리프트 방지

### Negative
- 모바일에서 services(gateway, telegram 등) 실행 불가 → 수용 가능 (데스크탑 전용 데몬)
- 파일 복사로 인한 미미한 레이턴시 추가

### Risks
- `$HOME/.claude/settings.json`을 bootstrap가 덮어쓰면 사용자 커스텀 설정 손실 가능
  - Mitigation: merge 로직으로 기존 설정 보존 (현재 구현됨)

---

## Validation

```bash
# 모바일 시뮬레이션 (hooks 디렉토리 삭제 후 재실행)
rm -rf ~/.claude/hooks && echo '{}' | node hooks/bootstrap.js
# → hooks 배포 + settings 동기화 + session-init 체인

# 2회차 (멱등성 확인)
echo '{}' | node hooks/bootstrap.js  # → ~150ms, 모두 skipped
```
