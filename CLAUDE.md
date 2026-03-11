# Claude Agent System v6

## 운영 원칙
- **한국어 대화**, 코드/로그는 영어
- 자율 진행 (파괴적 작업만 확인)
- 막히면 3가지 대안 먼저 시도
- 작업 끝날 때까지 멈추지 않기

## 비용 최적화
- 서브에이전트: Haiku 모델 (80% 절감)
- 사고 토큰: 10K 제한
- 적응형 압축: burn rate 기반 (70-90% 동적 트리거)

## 도구 우선순위
1. **Grep/Glob** → 파일/패턴 검색
2. **Read** → offset/limit으로 필요한 줄만
3. **Agent** → 독립 작업은 병렬 에이전트로

## 성능 모듈 (v6)
- `telemetry.js` → 세션 메트릭/훅 지연시간 수집
- `cache.js` → 인메모리 캐시 (정규식/시퀀스/TTL)
- `context-engine.js` → 구조화 스냅샷 (컴팩션 손실 방지)
- `token-budget.js` → 토큰 예산 추적/적응형 컴팩션
- `quality-gate.js` → 자동 린트/타입체크 (Stop 시점)

## Git
- defaultBranch=main
- force push 전 반드시 확인
