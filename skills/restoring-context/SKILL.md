---
name: restoring-context
description: "저장된 작업 컨텍스트 복원"
---

# Context Restore - 저장된 컨텍스트 복원

`~/.claude/contexts/` 에서 저장된 컨텍스트를 복원합니다.

## 동작
1. `~/.claude/contexts/` 디렉토리의 파일 목록을 표시
2. 사용자가 지정한 파일(또는 가장 최근 파일)을 읽기
3. 컨텍스트 내용을 요약하여 현재 세션에 로드
4. "다음 단계" 섹션 기반으로 작업 재개 제안

## 인자
- 인자 없음: 가장 최근 컨텍스트 파일 복원
- 파일명/키워드: 해당 컨텍스트 검색 후 복원

$ARGUMENTS
