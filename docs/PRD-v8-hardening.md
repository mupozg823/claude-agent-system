# PRD v8: Hardening & Cross-Platform Reliability

**Version**: 8.0
**Date**: 2026-03-11
**Status**: Draft
**Previous**: v7 (Sprint 1-3 완료), v6 (성능 최적화)

---

## 1. Executive Summary

v7까지 기능 확장에 집중했다면, v8은 **실제로 작동하는 시스템**으로 전환하는 단계.
모바일/데스크탑 양환경에서 안정적으로 동작하고, 보안 취약점을 제거하며,
테스트 커버리지를 신뢰 가능한 수준으로 끌어올린다.

**핵심 목표**: Score 5.7 → 7.5+ (실질적 품질 개선)

---

## 2. Problem Statement

### 2.1 현재 상태 (v7 Sprint 3 후)

| 영역 | 현재 | 문제 |
|------|------|------|
| **환경 호환** | 데스크탑 전용 설계 | 모바일(ephemeral container)에서 hooks 미배포, deps 미설치 |
| **보안** | CRITICAL 1건 | telegram-adapter `execSync` 커맨드 인젝션 |
| **Agent Teams** | 40% 기능 | 도구 제한 미적용, 컨텍스트 전달 비구조적 |
| **테스트** | 23 pass / 2 skip | v6 핵심 모듈 53개 별도 — 통합 부족 |
| **에러 처리** | 91개 empty catch | 운영 디버깅 불가 |
| **Services** | import 깨짐 | `./lib/paths` 경로 오류 (v8에서 수정 완료) |

### 2.2 v8 Bootstrap (이미 구현)

- `hooks/bootstrap.js`: SessionStart에서 환경 감지 → hooks/services 배포 → settings 동기화
- services/ import 경로 수정 (`./lib/paths` → `../hooks/lib/paths`)
- heartbeat.js 크로스플랫폼 (cron/schtasks)
- 모바일 ~150ms / 데스크탑 ~50ms 부트스트랩

---

## 3. Goals & Non-Goals

### Goals
- **G1**: 모바일/데스크탑 양환경에서 전체 hook chain 작동 (SessionStart → PostToolUse → Stop)
- **G2**: CRITICAL 보안 취약점 0건
- **G3**: Agent Teams 도구 제한 실제 적용
- **G4**: 테스트 커버리지 40개+ (핵심 모듈 통합 테스트)
- **G5**: empty catch → structured error logging (91 → <20)

### Non-Goals
- 새 기능 추가 (Skills, Gateway 확장 등)
- SWE-bench 벤치마킹
- 멀티모델 지원

---

## 4. Sprint Plan

### Sprint 1: Security & Safety (1-2일)

| ID | Feature | Priority | 변경량 |
|----|---------|----------|--------|
| S1-1 | telegram-adapter.js `execSync` → `execFileSync` + input sanitization | P0 | ~30 LOC |
| S1-2 | orchestrator-v2.js: `--allowedTools` 파라미터 적용 | P0 | ~20 LOC |
| S1-3 | dashboard-remote.html: 하드코딩된 Supabase anon key 제거 | P1 | ~10 LOC |
| S1-4 | relay-supabase.js: 명령 allowlist 강화 | P1 | ~15 LOC |

**검증**: 보안 체크리스트 통과, 인젝션 테스트

### Sprint 2: Error Handling & Observability (2-3일)

| ID | Feature | Priority | 변경량 |
|----|---------|----------|--------|
| S2-1 | `catch {}` → `catch (e) { err(e) }` 변환 (상위 30개) | P1 | ~100 LOC |
| S2-2 | hooks/lib/errors.js: 공통 에러 핸들러 모듈 | P1 | ~40 LOC |
| S2-3 | 텔레메트리 배열/Map 크기 제한 (메모리 누수 방지) | P1 | ~20 LOC |
| S2-4 | bootstrap.js에 에러 리포트 추가 | P2 | ~15 LOC |

**검증**: `grep -c 'catch {}' hooks/*.js` < 20

### Sprint 3: Testing & Validation (2-3일)

| ID | Feature | Priority | 변경량 |
|----|---------|----------|--------|
| S3-1 | bootstrap.js 테스트 (환경 감지, 배포, 멱등성) | P1 | ~60 LOC |
| S3-2 | orchestrator-v2.js 테스트 (도구 제한 검증) | P1 | ~50 LOC |
| S3-3 | quality-gate.js 통합 테스트 | P2 | ~40 LOC |
| S3-4 | services/ import 경로 검증 테스트 | P2 | ~30 LOC |

**검증**: `npm test` → 40+ passed, 0 failed

---

## 5. Success Criteria

| Metric | Before (v7) | After (v8) |
|--------|-------------|------------|
| 보안 취약점 | CRITICAL 1 + HIGH 2 | 0 |
| 테스트 | 23 pass, 2 skip | 40+ pass, 0 fail |
| empty catch | 91 | < 20 |
| 모바일 작동 | hooks 미배포 | 전체 hook chain 작동 |
| 데스크탑 작동 | services import 깨짐 | 전체 작동 |
| Agent Teams 도구 제한 | 미적용 (cosmetic) | 실제 적용 |
| 부트스트랩 시간 (모바일) | N/A | < 300ms |
| Score | 5.7 | 7.0+ |

---

## 6. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| `--allowedTools` CLI 미지원 | Teams 도구 제한 불가 | SDK `query()` 사용으로 전환 |
| npm install 네트워크 실패 (데스크탑) | 첫 세션 deps 없음 | 재시도 + 에러 메시지 |
| empty catch 제거 시 숨겨진 버그 노출 | 일시적 오류 증가 | Sprint 2에서 에러 핸들러 먼저 구현 |
| 테스트 추가로 CI 시간 증가 | 개발 속도 저하 | 테스트 ~1s 목표 (Node 내장만 사용) |

---

## 7. Dependencies

- Claude Code CLI `--allowedTools` 지원 확인 필요
- 모바일 환경에서 `$HOME/.claude/settings.json` 영속성 확인 (bootstrap가 매번 동기화하므로 OK)

---

## 8. Timeline

| Week | Sprint | 산출물 |
|------|--------|--------|
| Week 1 (Day 1-2) | Sprint 1 | 보안 수정 완료, P0 검증 |
| Week 1 (Day 3-5) | Sprint 2 | 에러 처리 개선, 관측성 강화 |
| Week 2 (Day 1-3) | Sprint 3 | 테스트 40+, 최종 검증 |
