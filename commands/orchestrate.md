# /orchestrate - 자율 오케스트레이션 엔진

고수준 목표를 입력받아 자동으로 분해하고 실행합니다.

## 사용법
`/orchestrate <목표>`

예시:
- `/orchestrate 이 프로젝트 빌드하고 테스트해`
- `/orchestrate 기술부채 분석 후 리팩토링`
- `/orchestrate 의존성 감사 + 보안 스캔 + 린트 수정`

## 실행 흐름

$ARGUMENTS 를 분석하여 아래 파이프라인으로 자율 실행하세요:

### 1. 목표 분석
- 현재 프로젝트의 package.json, 디렉토리 구조, git 상태 파악
- 목표를 원자적 스텝으로 분해 (DAG 구조)

### 2. DAG 생성
스텝들을 JSON DAG로 구성:
```json
[
  {"id": "step-1", "name": "의존성 설치", "type": "shell", "command": "npm install", "dependsOn": [], "parallel": true},
  {"id": "step-2", "name": "빌드", "type": "build", "dependsOn": ["step-1"]},
  {"id": "step-3", "name": "테스트", "type": "test", "dependsOn": ["step-1"], "parallel": true}
]
```

### 3. 실행
- 병렬 가능한 스텝은 Task 도구로 동시 실행
- 직렬 스텝은 순서대로 실행
- 각 스텝은 적절한 스킬이나 쉘 명령으로 라우팅

### 4. 스킬 라우팅
| type | skill |
|------|-------|
| build | /deploy |
| test | /w-tdd-cycle |
| lint | /fix-all |
| review | /review |
| debug | /t-smart-debug |
| refactor | /t-refactor |
| docs | /t-doc-generate |
| deps | /t-deps-audit |
| perf | /w-perf-optimize |
| shell | 직접 실행 |

### 5. 실패 복구
- 실패 시 최대 2회 재시도 (지수 백오프)
- 재시도 실패 시 사용자에게 보고

### 6. 결과 보고
- 각 스텝의 성공/실패 상태 표시
- 전체 실행 시간과 결과 요약
- 체크포인트 저장

## 중요
- orchestrator.js와 연동: `node ~/.claude/hooks/orchestrator.js`
- 대시보드에 실시간 진행 표시
- 실패한 스텝만 재실행 가능 (--resume)
