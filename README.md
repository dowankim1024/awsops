# AWSops 대시보드

> Steampipe + Next.js 14 기반 AWS 운영 대시보드에 **3D 인프라 토폴로지 뷰**를 얹은 프론트엔드 포트폴리오 프로젝트.
> `hojun121/awsops`(원류 `whchoi98/awsops`)에서 포크. 계획서: [docs/plans/2026-09-09-topology-3d-and-slimdown.md](docs/plans/2026-09-09-topology-3d-and-slimdown.md)

[![English](https://img.shields.io/badge/lang-English-blue.svg)](#awsops-dashboard-english)

## 무엇을 만드는가

- 수백~수천 대 규모의 VPC / 서브넷 / EC2 / ALB / RDS … 를 **React Three Fiber**로 3D 렌더링 (종류별 InstancedMesh, 60fps 목표)
- **체크박스, URL 파라미터, 자연어 채팅** 세 경로가 하나의 `TopologyFilter`를 조작 — "퍼블릭 서브넷이랑 람다는 빼고 a존만" → 필터 패치
- **설정 추론 흐름**: 보안그룹·IAM·VPC 엔드포인트·이벤트·DNS 설정에서 요청이 지나갈 수 있는 길을 뽑아 점선으로 잇는다. Route 53 → CloudFront → ALB → EC2 → 내부 ALB → EC2 → RDS·S3까지 한 화면에서 이어진다 (읽기 전용 조회만, 관측 트래픽 아님)
- **Live / Fixture / Generator** 세 데이터 소스. 자격증명 없이도 열리고, 시드 기반 생성기로 규모 테스트
- 그 아래에는 업스트림의 대시보드(EC2, VPC, RDS, S3, IAM, Cost, CIS 컴플라이언스 등 38 페이지)가 그대로 동작

## 아키텍처

```
노트북 ── SSM 포트 포워딩 :3000 ──► EC2 (프라이빗 서브넷, 인바운드 없음)
                                     ├─ Next.js :3000        대시보드 + 3D 토폴로지
                                     ├─ Steampipe :9193      내장 PG, AWS 380+ 테이블
                                     └─ Powerpipe (선택)     CIS 벤치마크
                                     인스턴스 롤 ─► ReadOnlyAccess + Bedrock 호출

Steampipe rows ─┐
Fixture JSON ───┼─► 어댑터 ─► TopologyGraph ─► applyFilter ─► layout3d ─► R3F Scene
Generator(seed)─┘        └ inferEdges          ▲
                        (설정 추론 5종)  FilterPanel · URL params · Chat(Bedrock → filter patch)
```

ALB, Cognito, CloudFront, AgentCore는 쓰지 않는다. AI는 Bedrock 직접 호출(토폴로지 채팅, AI 종합 진단)뿐이다.

## 빠른 시작

```bash
# 0. 인프라 (로컬) — EC2 + IAM 롤 + SG. 기존 VPC의 프라이빗 서브넷을 지정
VPC_ID=vpc-xxxx SUBNET_ID=subnet-xxxx bash scripts/00-deploy-infra.sh
#    콘솔에서 Bedrock 모델 접근 활성화 (계정 최초 1회)

# 1. EC2 (SSM 셸)
aws ssm start-session --target <INSTANCE_ID>
git clone <repo> ~/awsops && cd ~/awsops && bash scripts/install-all.sh   # 01 → 02 → 03 → 11
bash scripts/13-setup-steampipe-systemd.sh                                # Steampipe systemd (Restart=always)

# 2. 접속 (로컬)
aws ssm start-session --target <INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000
open http://localhost:3000
```

로컬 개발: `npm install && npm run build && npm start` (Steampipe 없이도 3D 토폴로지의 Fixture / Generator 모드는 동작).

### 운영

```bash
bash scripts/09-start-all.sh    # 시작 + 상태 + SSM 포트 포워딩 안내
bash scripts/10-stop-all.sh     # 중지
bash scripts/11-verify.sh       # 헬스체크
npm test                        # 순수 함수 테스트 (filter, layout3d, generator)
```

Step 13 이후 Steampipe는 `sudo systemctl {start|stop|restart} steampipe`로만 관리한다. CLI `steampipe service stop`은 Restart=always가 되돌린다.

## 프로젝트 구조

```
awsops/
├── src/
│   ├── app/                    # 38 페이지 + 15 API 라우트
│   │   ├── topology-3d/        # 3D 토폴로지 페이지 (Phase 3)
│   │   ├── api/topology3d-chat # 채팅 → 필터 패치 (Bedrock ConverseStream, Phase 4)
│   │   ├── api/steampipe       # 쿼리 실행 + 계정 관리
│   │   └── api/report          # AI 종합 진단 (DOCX/PDF)
│   ├── components/
│   │   └── topology3d/         # Scene, Ground, InstancedNodes, Edges, Labels, FilterPanel, SourcePanel, ChatPanel, PerfHud
│   └── lib/
│       ├── topology/           # types, filter, layout3d, anonymize, adapters/{live,fixture,generator}, fixtures/
│       ├── steampipe.ts        # pg Pool + 캐시
│       ├── queries/            # SQL 쿼리 (relationships.ts가 토폴로지 원천)
│       └── i18n/               # ko / en / zh
├── infra-cdk/                  # EC2 + 롤 + SG (ADR-011)
├── scripts/                    # 00 배포 · 01~03 설치 · 09/10 시작/중지 · 11 검증 · 13 systemd
├── powerpipe/                  # CIS 벤치마크
├── docs/                       # plans/, decisions/(ADR), runbooks/, perf/
└── tests/                      # 훅·구조 테스트 (bash)
```

## 기술 스택

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind (navy dark), Recharts, React Flow |
| 3D | three ^0.169, @react-three/fiber ^8, @react-three/drei ^9 (InstancedMesh, troika Text, OrbitControls) |
| Data | Steampipe (내장 PostgreSQL, AWS 플러그인), pg Pool, node-cache |
| AI | Amazon Bedrock (Claude, `global.*` 교차 리전 추론) — ConverseStream + toolConfig |
| Infra | CDK TypeScript, SSM Session Manager |
| Test | vitest (순수 함수), bash (훅·구조) |

## 문서

- [계획서](docs/plans/2026-09-09-topology-3d-and-slimdown.md) — 목표, 아키텍처, Phase 0~5
- [ARCHITECTURE.md](scripts/ARCHITECTURE.md) — 배포 형태와 데이터 흐름
- [docs/decisions/](docs/decisions/) — ADR (001 pg Pool … 011 SSM 전용 배포)
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Steampipe·Next.js 알려진 이슈
- [CHANGELOG.md](CHANGELOG.md)

---

# AWSops Dashboard (English)

> A frontend portfolio project: a **3D infrastructure topology view** on top of a Steampipe + Next.js 14 AWS operations dashboard.
> Forked from `hojun121/awsops` (origin `whchoi98/awsops`). Plan: [docs/plans/2026-09-09-topology-3d-and-slimdown.md](docs/plans/2026-09-09-topology-3d-and-slimdown.md)

- Renders VPCs / subnets / EC2 / ALB / RDS … at hundreds-to-thousands scale with **React Three Fiber** (per-kind InstancedMesh, 60fps target)
- **Checkboxes, URL params, and natural-language chat** all drive one `TopologyFilter` — "hide public subnets and lambdas, show only AZ a" becomes a filter patch
- **Flows inferred from configuration**: security groups, IAM, VPC endpoints, event sources and DNS become dashed lines, so Route 53 → CloudFront → ALB → EC2 → internal ALB → EC2 → RDS / S3 connects end to end (read-only calls; a permitted path, not observed traffic)
- **Live / Fixture / Generator** data sources: opens without credentials, seeded generator for scale tests
- The upstream dashboard (EC2, VPC, RDS, S3, IAM, Cost, CIS compliance, 38 pages) keeps working underneath

**Deployment**: one EC2 in a private subnet, no inbound rule, reached via SSM port forwarding. No ALB, Cognito, CloudFront, or AgentCore. AI is direct Bedrock only.

```bash
VPC_ID=vpc-xxxx SUBNET_ID=subnet-xxxx bash scripts/00-deploy-infra.sh     # local: EC2 + role + SG
aws ssm start-session --target <INSTANCE_ID>                             # then on EC2: bash scripts/install-all.sh
aws ssm start-session --target <INSTANCE_ID> --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=3000,localPortNumber=3000                      # http://localhost:3000
```

See the Korean section above for structure and stack. License: Apache-2.0
