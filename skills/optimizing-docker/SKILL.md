---
name: optimizing-docker
description: "Docker 이미지/컴포즈 최적화"
---

# Docker Optimize - Docker 최적화

Dockerfile 및 docker-compose 설정을 최적화하세요.

## 최적화 영역

### 이미지 크기
- 멀티스테이지 빌드 적용
- 불필요한 레이어 제거 (.dockerignore 검토)
- 경량 베이스 이미지 (alpine, distroless, slim)
- 패키지 캐시 정리

### 빌드 속도
- 레이어 캐싱 최적화 (변경 빈도 순 정렬)
- BuildKit 병렬 빌드
- COPY vs ADD 적절한 사용

### 보안
- 비 root 사용자 실행
- 시크릿 마운트 (--mount=type=secret)
- 불필요한 바이너리/쉘 제거

### Compose
- 헬스체크 추가
- 리소스 제한 (cpu, memory)
- 네트워크 분리
- 볼륨 최적화

## 출력
1. 현재 상태 분석 (이미지 크기, 레이어 수)
2. 최적화 적용
3. 개선 전후 비교

$ARGUMENTS
