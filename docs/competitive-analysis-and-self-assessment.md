# 경쟁 분석 및 자체 품질 평가 보고서

> 작성일: 2026-03-11 | Claude Agent System v6

---

## Part 1: 유사 시스템 비교 분석

### 직접 경쟁 시스템

| 시스템 | Stars | 규모 | 아키텍처 | 차별점 |
|--------|-------|------|----------|--------|
| **everything-claude-code** (ECC) | 62.7K | 997 tests, 14+ skills | 멀티-하네스 OS 레이어 | 크로스 플랫폼 (Cursor/Codex/OpenCode) |
| **claude-007-agents** | ~5K | 112 agents, 14 categories | Bridge Agent + 퍼스널리티 시스템 | 75+ 특화 AI, 멀티모델 |
| **claude-agents** (wshobson) | ~3K | 79 tools, 72 plugins | 그래뉼러 플러그인 | 토큰 최소화 (~1000 tokens/install) |
| **claude-skills** (alirezarezvani) | ~2K | 180+ skills | 스킬 마켓플레이스 | 프로덕션 레디, 멀티 에이전트 호환 |
| **ruflo** (ruvnet) | ~1K | 분산 스웜 | 오케스트레이션 플랫폼 | 엔터프라이즈 급, RAG 통합 |
| **우리 시스템** | N/A (비공개) | 8.3K LOC, 48 skills, 49 commands | 훅 기반 스캐폴드 | 성능 텔레메트리, 품질 게이트 |

### 간접 경쟁 (에이전트 프레임워크)

| 시스템 | SWE-bench | 아키텍처 | 특징 |
|--------|-----------|----------|------|
| **OpenHands** | 72% (Sonnet 4.5) | 이벤트 스트림 SDK | 모듈러 V1 SDK, IPython+브라우저+편집기 |
| **SWE-agent** | ~58% | ACI (에이전트-컴퓨터 인터페이스) | 연구 중심, 깔끔한 아키텍처 |
| **Confucius Code Agent** | 74.6% | 오케스트레이션+메모리 | 스캐폴딩이 모델 차이를 극복 |
| **LIVE-SWE-AGENT** | SOTA | 자기 진화형 스캐폴드 | 에이전트가 자체 스캐폴드를 런타임에 수정 |

### 핵심 인사이트

1. **ECC가 지배적**: 62.7K stars, 997 tests, 크로스 플랫폼 — 우리보다 훨씬 큰 규모
2. **토큰 효율성이 경쟁력**: wshobson의 시스템은 설치당 ~1000 tokens로 극한 최적화
3. **자기 진화가 트렌드**: LIVE-SWE-AGENT처럼 런타임에 스캐폴드 자체를 수정하는 패턴
4. **스캐폴딩 > 모델**: Confucius가 증명 — 좋은 스캐폴드가 모델 격차를 뒤집음
5. **멀티모델이 표준**: claude-007은 Claude/Gemini/OpenAI 모두 지원

---

## Part 2: 자체 품질 평가 (7차원)

### 1. 코드 품질: 6/10

**강점:**
- 일관된 모듈 패턴 (stdin → parse → process → stdout)
- 명확한 lib/ 공유 유틸리티
- graceful fallback: `try { require('./module') } catch {}`

**약점:**
- **Empty catch 패턴 만연**: 213개 try 블록 중 91개가 `catch {}` (43%)
  - gateway.js: 13건, audit-log.js: 9건, stop-check.js: 8건
  - 디버깅 시 에러 원인 추적 불가능
- **Dead code**: 테스트에서 삭제된 `smart-approve.js` 참조 남아있음
- **stdin 읽기 불일치**: pre-compact.js는 event-style, 나머지는 `for await` 패턴

### 2. 아키텍처 품질: 7/10

**강점:**
- 훅 인터페이스 일관성 (stdin JSON → stdout JSON)
- 공유 유틸리티 (`lib/paths.js`, `lib/utils.js`, `lib/cache.js`)
- 관심사 분리 양호 (감사/체크포인트/스킬/품질 분리)
- 순환 의존성 없음 (직접 훅 간)

**약점:**
- **모듈 크기 불균형**: gateway.js (49KB) vs cache.js (5KB) — 10배 차이
- **레거시 + 신규 이중 시스템**: commands/ (48개) + skills/ (49개) 중복
- **인프라 데몬이 hooks/에 혼재**: gateway, relay, telegram, heartbeat는 hooks가 아닌 별도 서비스

### 3. 신뢰성: 5/10

**강점:**
- 타임아웃 보호 (execSync에 3-10초 타임아웃)
- atomicWrite (temp → rename 패턴)
- 훅 실패 시 `{}` 반환 (graceful degradation)

**약점:**
- **파일 락 없음**: 동시 appendFileSync가 race condition 유발 가능
  - agent-engine.js에 10건의 동시 파일 쓰기
  - JSONL append는 OS 레벨에서 보통 atomic이지만 보장 안됨
- **디스크 풀/권한 오류 무시**: 대부분 `catch {}` → 데이터 손실 가능
- **메모리 제한 없음**: cache.js의 TTLCache/LRUCache에 max entries 없음 (TTL만 있음)

### 4. 테스트 가능성: 4/10

**강점:**
- tests/run-all.js 존재 (기존 25개 테스트)
- 모듈 분리로 단위 테스트 가능한 구조
- 순수 함수 많음 (`latencyStats()`, `scoreSkill()` 등)

**약점:**
- **신규 v6 모듈 테스트 0건**: telemetry, cache, context-engine, token-budget, quality-gate
- **ECC 대비 극히 부족**: ECC는 997 tests vs 우리 25 tests
- **DI 패턴 없음**: 전부 `require()` 직접 호출 → 모킹 어려움
- **E2E 파이프라인 테스트 없음**: 훅 체인 전체 흐름 검증 불가

### 5. 보안: 5/10

**강점:**
- 민감 파일 패턴 감지 (SENSITIVE 배열)
- 금지 명령어 설정 (settings.json deny)
- 세션 ID 자동 절단, 입력 크기 제한 (`slice(0, 500)` 등)

**약점:**
- **🔴 CRITICAL: telegram-adapter.js 커맨드 인젝션**
  - L347, L575: 사용자 Telegram 메시지가 `execSync`에 전달
  - `"` 이스케이프만 적용 — `$()`, 백틱, 줄바꿈 인젝션 미차단
  - `isAllowed` 블록리스트 (8패턴)는 `base64 -d | bash` 등으로 우회 가능
- **gateway.js L691**: execSync에 command 직접 전달
- **로그에 민감 정보 가능**: summary에 command 전체 (500자) 기록

### 6. 성능: 7/10 (v6 이후)

**측정 결과:**
| 모듈 | 로드 시간 |
|------|-----------|
| cache.js | **0.6ms** ✅ |
| telemetry.js | **5.5ms** |
| token-budget.js | **5.8ms** |
| context-engine.js | **16ms** (execSync 포함) |
| quality-gate.js | **15.6ms** (execSync 포함) |

**강점:**
- cache.js 0.6ms 로드 — 거의 즉시
- 인메모리 시퀀스 카운터 (2 disk I/O → 0 per call)
- 정규식 사전 컴파일

**약점:**
- context-engine/quality-gate가 16ms (execSync의 git 호출)
- 전체 훅 파이프라인은 여전히 동기 프로세스 포크 방식
- Claude Code 자체의 훅 실행 모델이 프로세스 포크 → 근본적 한계

### 7. 문서화: 7/10

**강점:**
- 각 모듈에 JSDoc 헤더 (목적, 버전, 개선사항)
- CLAUDE.md 경량화 완료 (v6)
- 코어 엔진 CLI 도움말 내장

**약점:**
- 아키텍처 다이어그램 없음
- 데이터 플로우 문서 없음
- API 레퍼런스 없음 (각 모듈의 export 목록)

---

## Part 3: 종합 평가

### 점수 요약

| 차원 | 점수 | ECC 추정 | 격차 |
|------|------|----------|------|
| 코드 품질 | 6/10 | 8/10 | -2 |
| 아키텍처 | 7/10 | 8/10 | -1 |
| 신뢰성 | 5/10 | 7/10 | -2 |
| 테스트 | 4/10 | 9/10 (997 tests) | **-5** |
| 보안 | **5/10** | 8/10 (AgentShield) | **-3** |
| 성능 | 7/10 | 7/10 | 0 |
| 문서화 | 7/10 | 7/10 | 0 |

**종합: 5.7/10** (ECC 추정: 7.7/10)

### 우리 시스템의 차별화 포인트

1. **성능 텔레메트리** — 대부분의 경쟁 시스템에 없음
2. **토큰 버짓 추적** — burn rate 기반 적응형 컴팩션은 독보적
3. **품질 게이트** — Stop 시점 자동 린트/타입체크는 ECC의 quality-gate와 유사
4. **구조화 스냅샷** — 컴팩션 손실 해결은 독자적 접근

### 치명적 격차

1. **테스트 커버리지**: 25 vs 997 — 가장 큰 약점
2. **크로스 플랫폼**: Claude Code 전용 vs ECC의 4개 플랫폼 지원
3. **커뮤니티**: 비공개 vs 62.7K stars

---

## Part 4: 우선순위 개선 항목

### P0 (즉시 — 보안/안정성)
1. **🔴 telegram-adapter.js 커맨드 인젝션 수정** — 사용자 입력 새니타이징 강화
2. **파일 락 구현**: agent-engine.js `queueComplete` read-modify-write 레이스 조건
3. **깨진 테스트 수정**: 5/25 실패 (smart-approve 참조, 누락 deps)

### P1 (1주 내 — 품질)
4. **테스트 추가**: 신규 5개 모듈에 최소 50개 테스트 작성
5. **Empty catch 정리**: 91개 `catch {}` → `catch (e) { stderr.write }` 변환
6. **메모리 누수 수정**: telemetry의 unbounded 배열/Map, utils의 `_latestFileCache` 미정리
7. **CLAUDE.md 정확성**: 모듈 수 17→22, 누락 모듈명 추가

### P2 (1개월 내 — 아키텍처)
8. **인프라 데몬 분리**: gateway/relay/telegram을 hooks/에서 services/로 이동
9. **E2E 파이프라인 테스트**: 훅 체인 전체 흐름 자동 검증
10. **아키텍처 문서**: 데이터 플로우 다이어그램 + API 레퍼런스

### P3 (장기 — 혁신)
11. **자기 진화 스캐폴드**: LIVE-SWE-AGENT 패턴 적용
12. **크로스 플랫폼**: Cursor/Codex 호환성 (ECC 패턴 참고)
13. **멀티모델 라우팅**: task complexity 기반 Opus/Sonnet/Haiku 자동 선택

---

## 출처

- [everything-claude-code](https://github.com/affaan-m/everything-claude-code/) — 62.7K stars, 멀티하네스 OS
- [claude-007-agents](https://github.com/avivl/claude-007-agents) — 112 agents, 14 categories
- [claude-agents](https://github.com/wshobson/agents) — 72 plugins, 토큰 최적화
- [claude-skills](https://github.com/alirezarezvani/claude-skills) — 180+ skills 마켓플레이스
- [ruflo](https://github.com/ruvnet/ruflo) — 분산 스웜 오케스트레이션
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — 커뮤니티 큐레이션
- [OpenHands SDK](https://arxiv.org/html/2511.03690v1) — 이벤트 스트림 아키텍처
- [Confucius Code Agent](https://arxiv.org/pdf/2512.10398) — 74.6% SWE-bench
- [LIVE-SWE-AGENT](https://arxiv.org/pdf/2511.13646) — 자기 진화형 스캐폴드
- [SWE-EVO Benchmark](https://arxiv.org/html/2512.18470) — 장기 소프트웨어 진화 벤치마크
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — 공식 문서
