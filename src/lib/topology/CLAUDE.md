# 토폴로지 모듈 (`src/lib/topology/`)

## 역할
모든 데이터 소스(Live / Fixture / Generator)와 모든 소비자(FossFLOW 생성기, 3D 레이아웃, 필터, 채팅 프롬프트)가 공유하는 **데이터 계약**과 **순수 함수**. 렌더러와 필터는 Steampipe를 모른다. ADR-010 참조.

```
Steampipe rows ─ adapters/live.ts ─┐
Fixture JSON ── adapters/fixture.ts ┼─► TopologyGraph ─► applyFilter(graph, filter) ─► layout3d ─► 렌더러
Generator ───── adapters/generator.ts ┘        (types.ts)        (filter.ts)
                                                     └─► buildFossflowModel (기존 Topology View)
```

## 파일
- `types.ts` — `TopologyGraph`(vpcs, subnets, nodes, edges, meta), `NodeKind` 17종, `Tier`, `EdgeKind` 4종, 상수 배열과 타입 가드
- `filter.ts` — `TopologyFilter`, `DEFAULT_FILTER`/`createDefaultFilter`, `applyFilter`(순수), `mergeFilter`(패치 병합), `filterToSearchParams`/`filterFromSearchParams`(URL 왕복), `resolveVpcId`
- `validate.ts` — `validateGraph(g): string[]` 구조·참조 검증. 빈 배열이면 유효. 픽스처 업로드와 어댑터 테스트에서 사용
- `anonymize.ts` — `anonymizeGraph(g, { seed, accountId })`. 라이브 그래프를 공유 가능한 픽스처로. 계정 ID·이름 태그·리소스 ID·IP·CIDR을 시드 기반 값으로 치환하고 `meta.anonymized`를 켠다
- `adapters/live.ts` — Steampipe 관계 쿼리 행 → `TopologyGraph`. 컬럼명을 아는 유일한 곳
- `adapters/generator.ts` — `generateGraph(params, opts)`, `PRESETS`(small/medium/large/stress), `mulberry32`, `normalizeParams`. 시드 기반 결정적 합성
- `adapters/fixture.ts` — `parseFixture`(검증 후 `meta.source='fixture'` 고정), `BUILT_IN_FIXTURES`, `toFixtureJson`(내보내기, 익명화 선택)
- `fixtures/` — `plick-prod.json`(익명화, 2 VPC·24 서브넷·390 EC2), `stress-1000.json`(2 VPC·32 서브넷·1,001 EC2). `npm run fixtures:build`로 재생성 (`scripts/build-topology-fixtures.ts`)
- `__tests__/` — vitest. `fixtures/live-rows.ts`(합성 행), `fixtures/fossflow-expected.json`(Phase 1 이전 생성기 산출물 스냅샷)
- `layout3d.ts` — `computeLayout(graph, { clusterThreshold, expanded })` → `Layout3D`(VPC 바닥판, AZ 레인, 티어 띠, 서브넷 단, 노드·스택 좌표, 접힌 엣지, 라벨, 앵커, 바운드, 통계). 순수·결정적. ADR-012

## 계약 요약
- **노드 id**: AWS 리소스 id가 있으면 그대로(`i-…`, `nat-…`, `igw-…`, `tgw-attach-…`, `vpce-…`). 없으면 `${kind}:${name}` (`alb:prod-alb`, `rds:prod-db`, `lambda:fn`, `s3:bucket`)
- **계정 전역 종류**(`GLOBAL_KINDS`: s3, dynamodb, cloudfront, route53)는 `vpcId`가 없다. `DEFAULT_FILTER.kinds`에서 기본 숨김
- **엣지 끝점**은 노드·서브넷·VPC id 중 하나. `target`(LB→인스턴스), `route`(서브넷→nat/igw/tgw), `attach`(igw/tgw→VPC), `egress`(nat→igw). 끝점이 사라지면 엣지도 사라진다
- **tier**는 어댑터가 정한다: 명시 연결 라우트 테이블 > 메인 테이블에 `igw-` 경로가 있으면 public, 테이블이 없으면 `map_public_ip_on_launch`
- **어댑터가 버리는 것**: terminated 인스턴스, deleted NAT/TGW 어태치먼트
- **`meta` 키** (kind별, 모두 선택): ec2 `nameTag instanceType privateIp publicIp eksCluster` · alb/nlb `arn scheme dnsName availabilityZones securityGroups` · tgw `transitGatewayId resourceType` · rds `engine instanceClass endpoint` · elasticache `engine` · msk `subnetIds azs` · opensearch `subnetIds azs engineVersion` · lambda `runtime subnetIds` · endpoint `serviceName endpointType` · s3 `region` · cloudfront `distributionId domainName aliases` · route53 `privateZone`. 소비자는 `typeof` 검사 후 읽는다
- **MSK/OpenSearch**는 다중 AZ라 `az`/`subnetId`를 비우고 `meta.azs`/`meta.subnetIds`에 담는다. Lambda는 첫 서브넷을 `subnetId`로

## 필터 규칙
- `vpcId: null` = 첫 VPC. 없는 id도 첫 VPC로 폴백 (`resolveVpcId`)
- 서브넷은 tier·AZ로 거르고, 서브넷이 빠지면 그 안의 노드도 빠진다. 서브넷이 없는 노드(ALB, RDS, IGW…)는 자기 `az`로만 거른다
- `includeEmptySubnets: false`면 노드가 없는 서브넷을 지운다 (query로 비워진 서브넷 포함)
- `query`는 노드 name·id 대소문자 무시 부분 일치
- 패치의 알 수 없는 kind/tier는 `mergeFilter`가 무시한다 (채팅 출력 방어)
- URL은 기본값과 다른 항목만: `vpc`, `tiers`(켜진 것), `hide`/`show`(기본과 반대인 kind), `az`, `empty=1`, `q`

## 생성기와 익명화
- **결정성이 계약이다.** 같은 `(params, seed, opts.now)`는 같은 그래프를 낸다. 난수는 `mulberry32` 하나, 호출 순서를 바꾸면 산출물이 바뀐다. 픽스처가 diff 없이 재생성되는지로 확인한다
- `PRESETS.stress`가 계획서 성공 기준(EC2 1,000 이상, 서브넷 30 이상, VPC 2)이고 100ms 안에 생성돼야 한다. 테스트가 둘 다 잡는다
- `ec2PerSubnet`은 프라이빗 서브넷 기준. 퍼블릭은 `ec2PerPublicSubnet`(기본 `[0, 2]`)으로 배스천 정도만 둔다
- 범위를 벗어난 파라미터는 `normalizeParams`가 자른다. 거절하지 않는다
- 익명화는 **식별 정보만** 바꾼다. AWS 어휘(`m6i.large`, `internet-facing`, `aurora-mysql`, `ap-northeast-2a`, ARN 키워드)는 그대로 둔다. 이름 태그에서 치환어를 만들고(mint), meta 문자열에는 이미 만들어진 치환만 적용한다
- 사설 IP는 두 번째 옥텟만 옮겨 서브넷 CIDR이 VPC CIDR 안에 남게 한다. 공인 IP는 `203.0.113.0/24`로 간다
- 익명화 후에도 `validateGraph`가 빈 배열이어야 한다 (참조 무결성 유지). 엣지 ID는 끝점에서 다시 만든다

## 3D 레이아웃 (`layout3d.ts`)
- 렌더러는 좌표를 계산하지 않는다. 위치·크기·라벨·엣지 끝점은 전부 `Layout3D`에서 온다
- 배치: VPC는 X축으로 나란히, AZ는 VPC 안 X축 레인, 티어는 Z축(퍼블릭이 +z, 카메라 쪽). 서브넷 단 위 격자는 종류 순(`NODE_KINDS`)으로 묶는다
- 서브넷이 없는 VPC 노드는 서비스 행: 앞(igw, tgw, internet-facing LB) · 중간(internal LB, endpoint, eks, 나머지) · 뒤(rds, elasticache, msk, opensearch). 계정 전역 노드는 오른쪽 트레이
- **클러스터링**: 서브넷 안 같은 종류가 `clusterThreshold`(기본 24, 0 이하면 비활성)를 넘으면 스택 하나(`${subnetId}:${kind}`). 멤버 앵커는 스택 꼭대기, `clusterOf`로 역참조. 같은 앵커 쌍의 엣지는 하나로 접히고 `sourceIds`에 원본을 남긴다. `expanded`는 UI 상태이며 필터가 아니다
- 엣지는 `from → mid → to` 두 선분. `mid`는 거리에 비례해 띄운다(0.6~4)
- `bounds.radius`는 0이 될 수 없다(빈 그래프도 1). 카메라 맞춤이 이 값을 쓴다
- 치수 상수는 `LAYOUT` 하나에 모아 둔다. 바꾸면 `layout3d.test.ts`의 겹침·포함 테스트가 잡는다

## 규칙
- 이 디렉터리의 함수는 **순수**하다. `Date.now()`는 `opts.now`로 주입. 네트워크·fs 접근 금지
- 새 소스는 어댑터 하나만 추가한다. 렌더러·필터 수정 금지
- FossFLOW 생성기 변경 시 `fossflow-parity.test.ts`가 깨지면 스냅샷을 다시 만들기 전에 화면 차이를 확인한다
- `npm test`로 검증 (vitest, `vitest.config.ts`)

---

# Topology Module (English)

## Role
The **data contract** and **pure functions** shared by every source (Live / Fixture / Generator) and every consumer (FossFLOW generator, 3D layout, filter, chat prompt). Renderer and filter never see Steampipe. See ADR-010.

## Files
- `types.ts` — `TopologyGraph` (vpcs, subnets, nodes, edges, meta), 17 `NodeKind`s, `Tier`, 4 `EdgeKind`s, constant arrays and type guards
- `filter.ts` — `TopologyFilter`, `DEFAULT_FILTER`/`createDefaultFilter`, `applyFilter` (pure), `mergeFilter` (patch merge), `filterToSearchParams`/`filterFromSearchParams` (URL round trip), `resolveVpcId`
- `validate.ts` — `validateGraph(g): string[]`; empty = valid. Used on fixture upload and in adapter tests
- `anonymize.ts` — `anonymizeGraph(g, { seed, accountId })` turns a live graph into a shareable fixture: account id, Name tags, resource ids, IPs and CIDRs become seed-derived stand-ins and `meta.anonymized` is set
- `adapters/live.ts` — Steampipe relationship rows → `TopologyGraph`. The only place that knows column names
- `adapters/generator.ts` — `generateGraph(params, opts)`, `PRESETS` (small/medium/large/stress), `mulberry32`, `normalizeParams`. Seeded, deterministic synthesis
- `adapters/fixture.ts` — `parseFixture` (validates, then pins `meta.source='fixture'`), `BUILT_IN_FIXTURES`, `toFixtureJson` (export, optional anonymization)
- `fixtures/` — `plick-prod.json` (anonymized; 2 VPC, 24 subnets, 390 EC2) and `stress-1000.json` (2 VPC, 32 subnets, 1,001 EC2). Rebuild with `npm run fixtures:build` (`scripts/build-topology-fixtures.ts`)
- `__tests__/` — vitest. `fixtures/live-rows.ts` (synthetic rows), `fixtures/fossflow-expected.json` (snapshot from the pre-Phase-1 generator)
- `layout3d.ts` — `computeLayout(graph, { clusterThreshold, expanded })` → `Layout3D` (VPC plates, AZ lanes, tier bands, subnet platforms, node / stack positions, folded edges, labels, anchors, bounds, stats). Pure and deterministic. ADR-012

## Contract summary
- **Node id**: the AWS resource id when one exists (`i-…`, `nat-…`, `igw-…`, `tgw-attach-…`, `vpce-…`), else `${kind}:${name}` (`alb:prod-alb`, `rds:prod-db`, `lambda:fn`, `s3:bucket`)
- **Account-global kinds** (`GLOBAL_KINDS`: s3, dynamodb, cloudfront, route53) have no `vpcId` and are hidden in `DEFAULT_FILTER.kinds`
- **Edge endpoints** are node, subnet, or VPC ids. `target` (LB→instance), `route` (subnet→nat/igw/tgw), `attach` (igw/tgw→VPC), `egress` (nat→igw). An edge disappears with either endpoint
- **tier** is decided by the adapter: explicit route-table association, else the main table; `igw-` route = public; no table at all → `map_public_ip_on_launch`
- **Dropped by the adapter**: terminated instances, deleted NAT gateways / TGW attachments
- **`meta` keys** (per kind, all optional): ec2 `nameTag instanceType privateIp publicIp eksCluster` · alb/nlb `arn scheme dnsName availabilityZones securityGroups` · tgw `transitGatewayId resourceType` · rds `engine instanceClass endpoint` · elasticache `engine` · msk `subnetIds azs` · opensearch `subnetIds azs engineVersion` · lambda `runtime subnetIds` · endpoint `serviceName endpointType` · s3 `region` · cloudfront `distributionId domainName aliases` · route53 `privateZone`. Consumers read them behind a `typeof` check
- **MSK/OpenSearch** span AZs, so `az`/`subnetId` stay empty and `meta.azs`/`meta.subnetIds` carry placement. Lambda uses its first subnet as `subnetId`

## Filter rules
- `vpcId: null` = first VPC; an unknown id also falls back to the first (`resolveVpcId`)
- Subnets are filtered by tier and AZ; a dropped subnet takes its nodes with it. Subnet-less nodes (ALB, RDS, IGW…) are filtered by their own `az` only
- `includeEmptySubnets: false` removes subnets left without nodes (including ones emptied by `query`)
- `query` is a case-insensitive substring match on node name or id
- `mergeFilter` ignores unknown kinds/tiers in a patch (defends against chat output)
- URL carries only non-default entries: `vpc`, `tiers` (enabled), `hide`/`show` (kinds that differ from default), `az`, `empty=1`, `q`

## Generator and anonymizer
- **Determinism is the contract.** The same `(params, seed, opts.now)` yields the same graph. There is one PRNG (`mulberry32`) and changing the order of its calls changes the output; the check is that regenerating the fixtures produces no diff
- `PRESETS.stress` is the plan's success criterion (1,000+ EC2, 30+ subnets, 2 VPCs) and must build in under 100ms. Tests assert both
- `ec2PerSubnet` applies to private subnets; public subnets use `ec2PerPublicSubnet` (default `[0, 2]`) so they hold bastions and little else
- Out-of-range params are clamped by `normalizeParams`, never rejected
- Anonymization replaces **identity only**. AWS vocabulary (`m6i.large`, `internet-facing`, `aurora-mysql`, `ap-northeast-2a`, ARN keywords) survives untouched: stand-ins are minted from Name tags, and meta strings only apply stand-ins that already exist
- A private IP moves only its second octet, so subnet CIDRs stay inside their VPC CIDR; public IPs become `203.0.113.0/24` addresses
- `validateGraph` must still return an empty array after anonymization (referential integrity). Edge ids are rebuilt from their endpoints

## 3D layout (`layout3d.ts`)
- The renderer computes no positions; position, size, labels and edge endpoints all come from `Layout3D`
- Placement: VPCs side by side on X, AZs as X lanes inside a VPC, tiers on Z (public at +z, toward the camera). The grid on a subnet platform is grouped by kind (`NODE_KINDS` order)
- Subnet-less VPC nodes go to service rows: front (igw, tgw, internet-facing LBs) · middle (internal LBs, endpoints, eks, everything else) · back (rds, elasticache, msk, opensearch). Account-global nodes sit in a tray on the right
- **Clustering**: more than `clusterThreshold` (default 24; disabled when <= 0) same-kind nodes in one subnet fold into one stack (`${subnetId}:${kind}`). Members anchor to the stack top and `clusterOf` maps back. Edges sharing an anchor pair fold into one, keeping originals in `sourceIds`. `expanded` is UI state, not filter state
- An edge is two segments `from → mid → to`; `mid` is lifted in proportion to distance (0.6–4)
- `bounds.radius` is never 0 (an empty graph gives 1); camera fitting relies on it
- All dimensions live in the single `LAYOUT` constant; the overlap / containment tests in `layout3d.test.ts` catch a bad change

## Rules
- Everything here is **pure**. Inject time via `opts.now`. No network or fs access
- A new source is one new adapter. Never touch renderer or filter for it
- If a FossFLOW generator change breaks `fossflow-parity.test.ts`, inspect the visual difference before regenerating the snapshot
- Verify with `npm test` (vitest, `vitest.config.ts`)
