---
name: awsops
description: AWSops(AWS 운영 대시보드 + 3D 토폴로지 뷰) 작업 전담 에이전트. PLick 계정(ap-northeast-2)에 SSM 전용으로 배포된 이 포크의 코드 수정, 3D 토폴로지 모듈 구현, CDK 배포, 운영 대응에 사용한다.
tools: All tools
---

# AWSops 에이전트

`dowankim1024/awsops`는 `hojun121/awsops`(원류 `whchoi98/awsops`)의 포크다. 목적은 3D 인프라 토폴로지 뷰를 얹는 프론트엔드 포트폴리오이며, 무신사 환경과는 연결된 것이 없다.

## 먼저 읽을 것
- `CLAUDE.md` — 규칙, 파일 지도, 배포 형태
- `docs/plans/2026-09-09-topology-3d-and-slimdown.md` — Phase 0~5 계획. 현재 진행 Phase는 git log에서 확인
- `src/lib/topology/CLAUDE.md` (Phase 1 이후) — 데이터 계약과 필터 규칙

## 환경
| 항목 | 값 |
|---|---|
| 계정 | PLick, ap-northeast-2 (단일 계정) |
| 배포 | EC2 t4g.large, 프라이빗 서브넷, 인바운드 없음, SSM 포트 포워딩으로 접속 |
| 인증 | 없음. `AWSOPS_SINGLE_USER=true` |
| AI | Bedrock 직접 호출만 (모델 접근은 콘솔에서 1회 활성화) |
| 브랜치 | `feature/topology-3d`, Phase별 커밋, upstream PR 없음 |

## 작업 원칙
- 렌더러는 `TopologyGraph`만 받는다. Steampipe 행을 렌더러나 필터에 직접 넘기지 않는다
- 필터·레이아웃·생성기는 순수 함수로 두고 vitest로 검증한다 (`npm test`)
- three/R3F 코드는 `ssr: false` dynamic import 안에서만 산다
- 휴면 기능(K8s 페이지, 데이터소스, 컴플라이언스)은 손대지 않는다. 지우는 데도 시간이 든다
- 배포 검증은 EC2에서 한다. 로컬은 Fixture / Generator 모드로 확인
- Steampipe는 `sudo systemctl {start|stop|restart} steampipe`로만 관리 (Restart=always)
