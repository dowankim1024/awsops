# AWSops 대시보드 — Claude 컨텍스트

> `dowankim1024/awsops`. 업스트림 `hojun121/awsops`(원류 `whchoi98/awsops`)에서 포크해 **3D 토폴로지 뷰**를 얹는 프론트엔드 포트폴리오 프로젝트.
> 대상 계정은 PLick(ap-northeast-2) 하나. 계획서: `docs/plans/2026-09-09-topology-3d-and-slimdown.md` · 전담 에이전트: `.claude/agents/awsops.md`

## 프로젝트 개요
Steampipe + Next.js 14로 AWS 리소스를 실시간 조회하는 운영 대시보드에, 수백~수천 노드를 3D로 그리고 체크박스·URL·자연어 채팅이 같은 필터를 조작하는 토폴로지 뷰를 추가한다.
AI는 Bedrock 직접 호출만 쓴다(토폴로지 채팅, AI 종합 진단). AgentCore, Cognito, ALB, 가이드 사이트는 Phase 0에서 걷어냈다.

## 아키텍처
- **프론트엔드**: Next.js 14 (App Router) + Tailwind 다크 테마 + Recharts + React Flow + **React Three Fiber v8** (3D 토폴로지)
- **데이터**: Steampipe 내장 PostgreSQL (포트 9193) — AWS 380+ 테이블. 멀티 어카운트 코드 경로는 남아 있으나 계정 1개로 운용
- **외부 데이터소스**: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog (휴면, 손대지 않음)
- **AI**: Bedrock 직접 호출 — `topology-chat`(FossFLOW 뷰), `topology3d-chat`(3D 필터 패치, ConverseStream + toolConfig), `report`(15섹션 진단)
- **인증**: 없음. EC2 인바운드 0, SSM 포트 포워딩으로만 접속. `AWSOPS_SINGLE_USER=true`면 `adminEmails` 검사를 통과 (`isSingleUser()`)
- **인프라**: CDK (`infra-cdk/`) → EC2 t4g.large + IAM 롤 + SG. VPC/서브넷은 `-c vpcId -c subnetId`로 주입 (ADR-011)
- **다국어**: 한국어/영어/중국어 — `src/lib/i18n` (플랫 키 JSON 3개, React Context + localStorage)

## 필수 규칙

### 데이터 접근
- 모든 쿼리는 `src/lib/steampipe.ts`의 **pg Pool**을 통해 실행 — `steampipe query` CLI 사용 금지 (660배 느림)
- 풀: `max 10, statement_timeout 30s, 클라이언트 하드 타임아웃 40s, batchQuery 5 sequential`. 결과는 node-cache 5분 (캐시키에 accountId 접두사)
- 컬럼명은 `information_schema.columns`로 확인 후 작성. SQL에 `$` 금지. 목록 쿼리에 `account_id` 포함

### Next.js
- `basePath` 없음 — 루트(`/`)에서 서빙. 모든 `fetch()`는 `/api/*`
- 컴포넌트는 `export default`. 프로덕션 빌드만 (`npm run build && npm start`)
- three/R3F는 `dynamic(() => import(...), { ssr: false })`로만 로드. `next.config.mjs`에 `transpilePackages: ['three']`

### 3D 토폴로지 모듈 (`src/lib/topology/`, `src/components/topology3d/`)
- 렌더러는 Steampipe를 모른다. `TopologyGraph`(types.ts)만 받는다
- 소스 3종(Live / Fixture / Generator)은 어댑터가 같은 `TopologyGraph`를 낸다. 렌더러 코드 변경 없이 전환
- 필터는 순수 함수 `applyFilter(graph, filter)`. 체크박스·URL·채팅 셋 다 `Partial<TopologyFilter>` → `mergeFilter`
- 채팅은 필터 패치만 만든다. 씬을 직접 건드리지 않는다. 프롬프트에는 스키마 + 현재 필터 + 그래프 요약만
- 성능: 노드는 종류별 `InstancedMesh`, 엣지는 단일 `LineSegments`, 라벨 상한, `frameloop="demand"`, 레이아웃은 `useMemo`
- 클러스터링 임계값 기본 24 (`config.topology3d.clusterThreshold`). 펼침 상태는 UI 상태, 필터 아님
- 생성기는 결정적이다. 같은 `(params, seed, opts.now)`는 같은 그래프. 픽스처는 `npm run fixtures:build`로 재생성하며 diff가 없어야 한다
- 익명화(`anonymize.ts`)는 식별 정보(계정 ID·이름 태그·리소스 ID·IP·CIDR)만 바꾸고 AWS 어휘는 그대로 둔다. 이후에도 `validateGraph`가 빈 배열이어야 한다
- 순수 함수(filter, layout3d, generator)는 vitest 테스트 필수 (`npm test`)

### 테마
- Navy: 900 (#0a0e1a), 800 (#0f1629), 700 (#151d30), 600 (#1a2540)
- 강조색: cyan (#00d4ff), green (#00ff88), purple (#a855f7), orange (#f59e0b), red (#ef4444)
- StatsCard `color`는 이름('cyan') 사용

## 주요 파일
- `src/lib/steampipe.ts` — pg 풀 + 배치 쿼리 + 캐시 + buildSearchPath
- `src/lib/queries/*.ts` — SQL 쿼리 파일 (`relationships.ts`가 토폴로지 원천)
- `src/lib/app-config.ts` — `data/config.json` 로더. `singleUser`, `topology3d`, `accounts[]`, `adminEmails`
- `src/lib/auth-utils.ts` — ALB 헤더/쿠키 없으면 `anonymous`
- `src/lib/topology/` — `TopologyGraph` 계약, `applyFilter`, 어댑터 3종(live/fixture/generator), `anonymize.ts`, `layout3d.ts`(순수 3D 레이아웃, ADR-012), `chat.ts`(채팅 요약·프롬프트·패치 검증·스트림 리듀서, ADR-013), `sse.ts`, `fixtures/`, vitest (ADR-010)
- `src/components/topology3d/` — R3F 렌더러(`Scene` `Ground` `InstancedNodes` `Edges` `Labels` `PerfHud`) + HTML 패널(`SourcePanel` `FilterPanel` `Inspector` `ChatPanel`). 페이지는 `src/app/topology-3d/page.tsx`, 훅은 `src/hooks/useTopologySource.ts`·`useTopologyFilter.ts`(URL 동기화), 채팅 API는 `src/app/api/topology3d-chat/route.ts`
- `src/lib/fossflow/generator.ts` — 기존 Topology View(FossFLOW) 모델 생성기. `TopologyGraph`를 입력으로 받음
- `src/lib/report-*.ts`, `src/app/api/report/` — AI 종합 진단 (Bedrock 직접 호출, DOCX/PDF)
- `src/lib/cache-warmer.ts` — 대시보드 쿼리 프리워밍 (4분 주기)
- `src/app/api/steampipe/route.ts` — 쿼리 실행 + 계정 관리 (관리자 게이팅)
- `infra-cdk/lib/awsops-stack.ts` — EC2 + 롤 + SG
- `scripts/` — `00`(CDK 배포, 로컬) `01~03`(설치·빌드) `09/10`(시작/중지) `11`(검증) `13`(Steampipe systemd) · `build-topology-fixtures.ts`(픽스처 재생성, `npm run fixtures:build`)

### 설정 파일 (`data/config.json`, gitignore)
```json
{
  "costEnabled": true,
  "singleUser": true,
  "topology3d": { "chatModelId": "global.anthropic.claude-opus-4-8", "clusterThreshold": 24, "defaultSource": "generator" },
  "accounts": [
    { "accountId": "111111111111", "alias": "PLick", "connectionName": "aws_111111111111", "region": "ap-northeast-2", "isHost": true,
      "features": { "costEnabled": true, "eksEnabled": false, "k8sEnabled": false } }
  ]
}
```

## 배포 (SSM 전용)
```
노트북 ── SSM 포트 포워딩 :3000 ──► EC2 (프라이빗 서브넷, 인바운드 없음)
                                     ├─ Next.js :3000   ├─ Steampipe :9193   └─ Powerpipe (선택)
```
1. 로컬: `VPC_ID=... SUBNET_ID=... bash scripts/00-deploy-infra.sh`
2. 콘솔에서 Bedrock 모델 접근 활성화 (계정 최초 1회)
3. EC2(SSM 셸): `git clone … ~/awsops && bash scripts/install-all.sh` → `bash scripts/13-setup-steampipe-systemd.sh`
4. 로컬: `aws ssm start-session --target <id> --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000`
5. 미사용 시 인스턴스 정지. Steampipe는 `sudo systemctl {start|stop|restart} steampipe`로만 관리

## 작업 규칙
- 브랜치 `feature/topology-3d`. Phase별 커밋. upstream PR 없음
- 새 페이지: `information_schema` 확인 → `src/lib/queries/<x>.ts` → `src/app/<x>/page.tsx` → `Sidebar.tsx` → 빌드 → `src/app/CLAUDE.md` 갱신
- `src/` 새 디렉터리에는 `CLAUDE.md`. ADR은 `docs/decisions/NNN-*.md` 최대 번호 + 1 (현재 013, 다음 014)
- 훅: `.claude/hooks/secret-scan.sh`(Write/Edit 전), `pre-commit.sh`(Bash 전), `check-doc-sync.sh`(Write/Edit 후)

---

# AWSops Dashboard — Claude Context (English)

> `dowankim1024/awsops`, forked from `hojun121/awsops` (origin `whchoi98/awsops`). A frontend portfolio project that adds a **3D topology view**.
> Single target account: PLick (ap-northeast-2). Plan: `docs/plans/2026-09-09-topology-3d-and-slimdown.md` · agent: `.claude/agents/awsops.md`

## Overview
Steampipe + Next.js 14 AWS operations dashboard, extended with a topology view that renders hundreds to thousands of nodes in 3D, where checkboxes, URL params, and natural-language chat all drive one shared filter.
AI is direct Bedrock only (topology chat, AI diagnosis). AgentCore, Cognito, ALB, and the guide site were removed in Phase 0.

## Architecture
- **Frontend**: Next.js 14 App Router + Tailwind dark theme + Recharts + React Flow + **React Three Fiber v8** (3D topology)
- **Data**: Steampipe embedded PostgreSQL (:9193), 380+ AWS tables. Multi-account code path remains but runs with one account
- **External datasources**: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog (dormant, untouched)
- **AI**: direct Bedrock — `topology-chat` (FossFLOW view), `topology3d-chat` (3D filter patches via ConverseStream + toolConfig), `report` (15-section diagnosis)
- **Auth**: none. EC2 has no inbound rule; access is SSM port forwarding only. `AWSOPS_SINGLE_USER=true` bypasses `adminEmails` (`isSingleUser()`)
- **Infra**: CDK (`infra-cdk/`) → EC2 t4g.large + IAM role + SG. VPC/subnet injected via `-c vpcId -c subnetId` (ADR-011)
- **i18n**: ko/en/zh — `src/lib/i18n` (three flat-key JSON files, React Context + localStorage)

## Critical Rules

### Data access
- Every query goes through the **pg Pool** in `src/lib/steampipe.ts`. Never the `steampipe query` CLI (660x slower)
- Pool: max 10, 30s statement timeout, 40s client-side hard timeout, batchQuery 5 sequential. node-cache 5 min, accountId-prefixed keys
- Verify columns via `information_schema.columns`. No `$` in SQL. List queries include `account_id`

### Next.js
- No `basePath`; served at `/`. All `fetch()` URLs are `/api/*`
- Components use `export default`. Production build only (`npm run build && npm start`)
- Load three/R3F only via `dynamic(() => import(...), { ssr: false })`. `next.config.mjs` has `transpilePackages: ['three']`

### 3D topology module (`src/lib/topology/`, `src/components/topology3d/`)
- The renderer never sees Steampipe. It consumes `TopologyGraph` (types.ts) only
- Three sources (Live / Fixture / Generator) produce the same `TopologyGraph` through adapters; switching needs no renderer change
- Filtering is the pure function `applyFilter(graph, filter)`. Checkboxes, URL, and chat all produce `Partial<TopologyFilter>` → `mergeFilter`
- Chat only produces filter patches; it never touches the scene. Prompt carries schema + current filter + graph summary only
- Performance: per-kind `InstancedMesh`, one `LineSegments` for edges, label cap, `frameloop="demand"`, layout in `useMemo`
- Cluster threshold defaults to 24 (`config.topology3d.clusterThreshold`). Expanded state is UI state, not filter
- The generator is deterministic: the same `(params, seed, opts.now)` gives the same graph. Fixtures are rebuilt with `npm run fixtures:build` and must produce no diff
- `anonymize.ts` replaces identity only (account id, Name tags, resource ids, IPs, CIDRs) and leaves AWS vocabulary intact; `validateGraph` must still pass afterwards
- Pure functions (filter, layout3d, generator) need vitest tests (`npm test`)

### Theme
- Navy: 900 (#0a0e1a), 800 (#0f1629), 700 (#151d30), 600 (#1a2540)
- Accents: cyan (#00d4ff), green (#00ff88), purple (#a855f7), orange (#f59e0b), red (#ef4444)
- StatsCard `color` uses names ('cyan')

## Key Files
- `src/lib/steampipe.ts` — pg Pool + batch + cache + buildSearchPath
- `src/lib/queries/*.ts` — SQL query files (`relationships.ts` feeds the topology)
- `src/lib/app-config.ts` — `data/config.json` loader: `singleUser`, `topology3d`, `accounts[]`, `adminEmails`
- `src/lib/auth-utils.ts` — falls back to `anonymous` without ALB header/cookie
- `src/lib/topology/` — `TopologyGraph` contract, `applyFilter`, three adapters (live/fixture/generator), `anonymize.ts`, `layout3d.ts` (pure 3D layout, ADR-012), `chat.ts` (chat summary / prompt / patch validation / stream reducer, ADR-013), `sse.ts`, `fixtures/`, vitest (ADR-010)
- `src/components/topology3d/` — R3F renderer (`Scene` `Ground` `InstancedNodes` `Edges` `Labels` `PerfHud`) + HTML panels (`SourcePanel` `FilterPanel` `Inspector` `ChatPanel`). Page: `src/app/topology-3d/page.tsx`; hooks `src/hooks/useTopologySource.ts` and `useTopologyFilter.ts` (URL sync); chat API `src/app/api/topology3d-chat/route.ts`
- `src/lib/fossflow/generator.ts` — existing Topology View (FossFLOW) model generator, now fed a `TopologyGraph`
- `src/lib/report-*.ts`, `src/app/api/report/` — AI diagnosis (direct Bedrock, DOCX/PDF)
- `src/lib/cache-warmer.ts` — dashboard query pre-warming (4 min)
- `src/app/api/steampipe/route.ts` — query execution + account management (admin gating)
- `infra-cdk/lib/awsops-stack.ts` — EC2 + role + SG
- `scripts/` — `00` (CDK deploy, local) `01~03` (install/build) `09/10` (start/stop) `11` (verify) `13` (Steampipe systemd) · `build-topology-fixtures.ts` (fixture rebuild, `npm run fixtures:build`)

## Deployment (SSM only)
1. Local: `VPC_ID=... SUBNET_ID=... bash scripts/00-deploy-infra.sh`
2. Enable Bedrock model access in the console (once per account)
3. EC2 (SSM shell): `git clone … ~/awsops && bash scripts/install-all.sh` → `bash scripts/13-setup-steampipe-systemd.sh`
4. Local: `aws ssm start-session --target <id> --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000`
5. Stop the instance when idle. Manage Steampipe only via `sudo systemctl {start|stop|restart} steampipe`

## Working Rules
- Branch `feature/topology-3d`, one commit per Phase, no upstream PR
- New page: check `information_schema` → `src/lib/queries/<x>.ts` → `src/app/<x>/page.tsx` → `Sidebar.tsx` → build → update `src/app/CLAUDE.md`
- New directory under `src/` gets a `CLAUDE.md`. ADR numbering: highest in `docs/decisions/` + 1 (currently 013, next 014)
- Hooks: `.claude/hooks/secret-scan.sh` (pre Write/Edit), `pre-commit.sh` (pre Bash), `check-doc-sync.sh` (post Write/Edit)
