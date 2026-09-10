# 토폴로지 모듈 (`src/lib/topology/`)

## 역할
모든 데이터 소스(Live / Fixture / Generator)와 모든 소비자(FossFLOW 생성기, 3D 레이아웃, 필터, 채팅 프롬프트)가 공유하는 **데이터 계약**과 **순수 함수**. 렌더러와 필터는 Steampipe를 모른다. ADR-010 참조.

```
Steampipe rows ─ adapters/live.ts ─┐
Fixture JSON ── adapters/fixture.ts ┼─► TopologyGraph ─► applyFilter(graph, filter) ─► layout3d ─► 렌더러
Generator ───── adapters/generator.ts ┘   ▲    (types.ts)        (filter.ts)
                                          └ infer.ts: 설정 사실 ─► 추론 엣지 5종 (ADR-014)
                                                     └─► buildFossflowModel (기존 Topology View)
```

## 파일
- `types.ts` — `TopologyGraph`(vpcs, subnets, nodes, edges, meta), `NodeKind` 17종, `Tier`, `EdgeKind` 9종(명시 4 + 추론 5), `TopologyEdgeMeta`, 상수 배열과 타입 가드
- `filter.ts` — `TopologyFilter`, `DEFAULT_FILTER`/`createDefaultFilter`, `applyFilter`(순수), `mergeFilter`(패치 병합), `filterToSearchParams`/`filterFromSearchParams`(URL 왕복), `resolveVpcId`
- `infer.ts` — `inferEdges(input, graph)`: 정규화된 설정 사실 → 추론 엣지 5종(`allows` `permits` `endpoint` `triggers` `origin`). 순수 함수, 규칙은 여기에만 있다. `withInferredEdges`, `cidrContains`, ARN·도메인 파서. ADR-014
- `validate.ts` — `validateGraph(g): string[]` 구조·참조 검증. 빈 배열이면 유효. 픽스처 업로드와 어댑터 테스트에서 사용
- `anonymize.ts` — `anonymizeGraph(g, { seed, accountId })`. 라이브 그래프를 공유 가능한 픽스처로. 계정 ID·이름 태그·리소스 ID·IP·CIDR을 시드 기반 값으로 치환하고 `meta.anonymized`를 켠다
- `adapters/live.ts` — Steampipe 관계 쿼리 행 → `TopologyGraph`. 컬럼명을 아는 유일한 곳
- `adapters/generator.ts` — `generateGraph(params, opts)`, `PRESETS`(small/medium/large/stress), `mulberry32`, `normalizeParams`. 시드 기반 결정적 합성
- `adapters/fixture.ts` — `parseFixture`(검증 후 `meta.source='fixture'` 고정), `BUILT_IN_FIXTURES`, `toFixtureJson`(내보내기, 익명화 선택)
- `fixtures/` — `plick-prod.json`(익명화, 2 VPC·24 서브넷·390 EC2·2,097 엣지), `stress-1000.json`(2 VPC·32 서브넷·1,001 EC2·7,026 엣지). `npm run fixtures:build`로 재생성 (`scripts/build-topology-fixtures.ts`)
- `__tests__/` — vitest. `fixtures/live-rows.ts`(합성 행 + 추론용 `liveInferRows`), `fixtures/infer-rows.ts`(추론 규칙용 작은 계정), `fixtures/fossflow-expected.json`(Phase 1 이전 생성기 산출물 스냅샷)
- `layout3d.ts` — `computeLayout(graph, { clusterThreshold, expanded })` → `Layout3D`(VPC 바닥판, AZ 레인, 티어 띠, 서브넷 단, 트레이 3종, 노드·스택 좌표, 접힌 엣지, 라벨, 앵커, 바운드, 통계). 순수·결정적. ADR-012 / ADR-014
- `chat.ts` — 필터 채팅의 순수 부분: `summarizeGraph`, `buildSystemPrompt`, `SET_FILTER_TOOL`, `sanitizePatch`/`sanitizeFilter`/`sanitizeSummary`/`toConverseMessages`, `createConverseReducer`, `diffFilter`. ADR-013
- `sse.ts` — SSE 인코더/디코더 (라우트와 ChatPanel 공용)

## 계약 요약
- **노드 id**: AWS 리소스 id가 있으면 그대로(`i-…`, `nat-…`, `igw-…`, `tgw-attach-…`, `vpce-…`). 없으면 `${kind}:${name}` (`alb:prod-alb`, `rds:prod-db`, `lambda:fn`, `s3:bucket`)
- **계정 전역 종류**(`GLOBAL_KINDS`: s3, dynamodb, cloudfront, route53)는 `vpcId`가 없다. `DEFAULT_FILTER.kinds`에서 기본 숨김
- **엣지 끝점**은 노드·서브넷·VPC id 중 하나. 끝점이 사라지면 엣지도 사라진다
  - **명시 관계**(`EXPLICIT_EDGE_KINDS`, `meta.derived` 없음): `target`(LB→인스턴스), `route`(서브넷→nat/igw/tgw), `attach`(igw/tgw→VPC), `egress`(nat→igw)
  - **설정 추론**(`DERIVED_EDGE_KINDS`, `meta.derived` 필수): `allows`(SG가 연 경로, `meta.ports`·`protocol`), `permits`(IAM 허용, `meta.actions`·`roleArn`), `endpoint`(서브넷→VPC 엔드포인트), `triggers`(이벤트→Lambda, `meta.disabled`), `origin`(CloudFront·Route 53 오리진). **허용된 경로이지 실제 트래픽이 아니다** — 화면에서 점선으로 구분한다
- **tier**는 어댑터가 정한다: 명시 연결 라우트 테이블 > 메인 테이블에 `igw-` 경로가 있으면 public, 테이블이 없으면 `map_public_ip_on_launch`
- **어댑터가 버리는 것**: terminated 인스턴스, deleted NAT/TGW 어태치먼트
- **추론용 `meta` 키**: ec2·lambda `securityGroups roleArn iamWildcard` · alb/nlb/rds/elasticache/msk/opensearch `securityGroups` · endpoint `routeTableIds subnetIds` · s3 `domain` · route53 `zoneId records`(개수). `iamWildcard`는 `Resource: "*"` 배지이며 선을 만들지 않는다
- **`meta` 키** (kind별, 모두 선택): ec2 `nameTag instanceType privateIp publicIp eksCluster` · alb/nlb `arn scheme dnsName availabilityZones securityGroups` · tgw `transitGatewayId resourceType` · rds `engine instanceClass endpoint` · elasticache `engine` · msk `subnetIds azs` · opensearch `subnetIds azs engineVersion` · lambda `runtime subnetIds` · endpoint `serviceName endpointType` · s3 `region` · cloudfront `distributionId domainName aliases` · route53 `privateZone`. 소비자는 `typeof` 검사 후 읽는다
- **MSK/OpenSearch**는 다중 AZ라 `az`/`subnetId`를 비우고 `meta.azs`/`meta.subnetIds`에 담는다. Lambda는 첫 서브넷을 `subnetId`로

## 필터 규칙
- `vpcId: null` = 첫 VPC. 없는 id도 첫 VPC로 폴백 (`resolveVpcId`)
- 서브넷은 tier·AZ로 거르고, 서브넷이 빠지면 그 안의 노드도 빠진다. 서브넷이 없는 노드(ALB, RDS, IGW…)는 자기 `az`로만 거른다
- `includeEmptySubnets: false`면 노드가 없는 서브넷을 지운다 (query로 비워진 서브넷 포함)
- `query`는 노드 name·id 대소문자 무시 부분 일치
- 패치의 알 수 없는 kind/tier는 `mergeFilter`가 무시한다 (채팅 출력 방어)
- `edgeKinds`(9종, 기본 전부 켬)로 엣지 종류를 끈다. 끝점 노드는 남고 선만 사라진다
- `showConnectedGlobals`(기본 켬): 종류가 꺼진 전역 노드라도 **보이는 엣지가 닿으면** 남긴다. 한 번만 훑고 전이 폐포는 만들지 않는다(전역→전역 두 홉 없음). 종류 외 조건(query, az)은 그대로 적용된다
- URL은 기본값과 다른 항목만: `vpc`, `tiers`(켜진 것), `hide`/`show`(기본과 반대인 kind), `hideEdges`(꺼진 엣지 종류), `globals=0`, `az`, `empty=1`, `q`

## 생성기와 익명화
- **결정성이 계약이다.** 같은 `(params, seed, opts.now)`는 같은 그래프를 낸다. 난수는 `mulberry32` 하나, 호출 순서를 바꾸면 산출물이 바뀐다. 픽스처가 diff 없이 재생성되는지로 확인한다
- `PRESETS.stress`가 계획서 성공 기준(EC2 1,000 이상, 서브넷 30 이상, VPC 2)이고 100ms 안에 생성돼야 한다. 테스트가 둘 다 잡는다
- `ec2PerSubnet`은 프라이빗 서브넷 기준. 퍼블릭은 `ec2PerPublicSubnet`(기본 `[0, 2]`)으로 배스천 정도만 둔다
- 범위를 벗어난 파라미터는 `normalizeParams`가 자른다. 거절하지 않는다
- 익명화는 **식별 정보만** 바꾼다. AWS 어휘(`m6i.large`, `internet-facing`, `aurora-mysql`, `ap-northeast-2a`, ARN 키워드)는 그대로 둔다. 이름 태그에서 치환어를 만들고(mint), meta 문자열에는 이미 만들어진 치환만 적용한다
- 사설 IP는 두 번째 옥텟만 옮겨 서브넷 CIDR이 VPC CIDR 안에 남게 한다. 공인 IP는 `203.0.113.0/24`로 간다
- 익명화 후에도 `validateGraph`가 빈 배열이어야 한다 (참조 무결성 유지). 엣지 ID는 끝점에서 다시 만든다
- 추론 엣지의 `meta`는 남는다. 롤 ARN만 치환하고 `actions`(`s3:GetObject`)·`ports`·`protocol`·`derived`는 AWS 어휘라 그대로 둔다

## 3D 레이아웃 (`layout3d.ts`)
- 렌더러는 좌표를 계산하지 않는다. 위치·크기·라벨·엣지 끝점은 전부 `Layout3D`에서 온다
- 배치: VPC는 X축으로 나란히, AZ는 VPC 안 X축 레인, 티어는 Z축(퍼블릭이 +z, 카메라 쪽). 서브넷 단 위 격자는 종류 순(`NODE_KINDS`)으로 묶는다
- 서브넷이 없는 VPC 노드는 서비스 행: 앞(igw, tgw, internet-facing LB) · 중간(internal LB, endpoint, eks, 나머지) · 뒤(rds, elasticache, msk, opensearch). 계정 전역 노드는 트레이 3종(`trays[]`) — 선이 닿는 CloudFront·Route 53은 VPC **앞** 띠(+z), 선이 닿는 S3·DynamoDB는 **뒤** 띠(-z), 선이 없는 나머지는 오른쪽 **옆** 트레이
- 엣지 중간점은 종류마다 다른 높이로 띄운다(`EDGE_LIFT`) + 엣지마다 결정적 높이 변화(`LAYOUT.edgeJitter`, 최대 0.135 < 종류 간격 0.2). 같은 두 앵커를 잇는 명시·추론 엣지가 겹치지 않고, 같은 곳을 지나는 두 호도 같은 평면에 놓이지 않는다
- **엣지 접힘 2단계**: 스택 접힘이 먼저, 그다음 `edgeFoldThreshold`(기본 3, 1 이하면 비활성) 기준 서브넷 접힘. 한 서브넷의 노드 여럿이 같은 추론 엣지(같은 종류·같은 반대편)를 가지면 그 끝이 서브넷 앵커로 간다. **명시 관계는 접지 않는다.** 원본은 `sourceIds`에 남는다
- `edgeIndexByElement`(요소 id → `edges` 인덱스)는 접힘을 모르는 렌더러가 선택에 닿는 선을 찾는 유일한 경로다. 접힌 엣지의 `fromId`/`toId`는 클릭된 id와 다를 수 있다
- **클러스터링**: 서브넷 안 같은 종류가 `clusterThreshold`(기본 24, 0 이하면 비활성)를 넘으면 스택 하나(`${subnetId}:${kind}`). 멤버 앵커는 스택 꼭대기, `clusterOf`로 역참조. 같은 앵커 쌍의 엣지는 하나로 접히고 `sourceIds`에 원본을 남긴다. `expanded`는 UI 상태이며 필터가 아니다
- 엣지는 `from → mid → to` 두 선분. `mid`는 거리에 비례해 띄운다(0.6~4)
- `bounds.radius`는 0이 될 수 없다(빈 그래프도 1). 카메라 맞춤이 이 값을 쓴다
- 치수 상수는 `LAYOUT` 하나에 모아 둔다. 바꾸면 `layout3d.test.ts`의 겹침·포함 테스트가 잡는다

## 채팅 (`chat.ts`, `sse.ts`)
- 채팅은 **필터 패치만** 만든다. 그래프는 모델에 가지 않고 `summarizeGraph(graph, filter)`(VPC 목록, 현재 VPC의 AZ·티어별 서브넷 수·종류별 노드 수)만 프롬프트에 들어간다. 프롬프트 크기는 노드 수와 무관하다
- `SET_FILTER_TOOL`이 Bedrock `toolConfig`에 그대로 들어가는 JSON 스키마다. kind·tier 목록은 `types.ts` 상수에서 만들어 새 종류가 자동으로 포함된다
- `sanitizePatch(raw, summary)`가 모델 출력을 검증한다. 모르는 kind·tier는 버리고 `rejected`에 남긴다. AZ는 요약 목록에 정확 일치 → 접미사 일치(`2a`, `a`, 유일할 때만), VPC는 id → 이름. 하나도 못 푼 AZ 목록은 적용하지 않는다(화면을 비우지 않기 위해). `sanitizeFilter`·`sanitizeSummary`·`toConverseMessages`는 클라이언트 입력을 같은 원칙으로 정규화한다(user 우선 교대, 빈 assistant 텍스트 대체, 최근 10턴)
- `createConverseReducer()`는 ConverseStream 이벤트(구조적 타입, SDK import 없음)를 텍스트와 도구 호출로 접는다. 도구 입력 JSON은 델타를 이어 붙여 `contentBlockStop`에서 파싱한다
- `diffFilter(before, after)`는 UI의 "무엇이 바뀌었나" 칩용. AZ 순서 차이는 변경이 아니다
- `sse.ts`: `encodeSse(event, data)` / `createSseDecoder()`. 청크 경계·CRLF·주석·마지막 빈 줄 누락을 처리한다
- 라우트(`src/app/api/topology3d-chat`)는 이 함수들을 Bedrock과 `ReadableStream`에 잇기만 한다. ADR-013

## 설정 추론 (`infer.ts`, ADR-014)
- 입력은 **Steampipe 행이 아니라 정규화된 사실**(`SgRuleFact` `RoleGrantFact` `EndpointFact` `EventSourceFact` `BucketNotificationFact` `OriginFact` `DnsRecordFact`)이다. 라이브 어댑터가 행을 옮기고 생성기가 같은 형태를 합성하므로 두 소스가 같은 규칙을 지난다
- 노이즈 접기 셋: `Resource: "*"`는 선을 만들지 않고 `meta.iamWildcard` 배지로만 · VPC CIDR 전체를 덮는 규칙은 VPC 앵커 하나로 · `0.0.0.0/0`은 IGW를 출발점으로
- 같은 `(from, to, kind)`는 엣지 하나다. `ports`·`actions`는 그 위에 누적된다(3306·6379가 한 선)
- 컨트롤 평면 액션(`s3:ListAllMyBuckets`, `dynamodb:DescribeTable`)은 요청 경로가 아니므로 제외한다
- 그래프에 없는 끝점은 엣지를 만들지 않는다. 그래서 `withInferredEdges` 뒤에도 `validateGraph`가 빈 배열이다
- 도메인 매칭은 ALB `dns_name`·S3 버킷 도메인과 **정확히 일치**할 때만. 커스텀 오리진은 잇지 않는다
- 규칙마다 양성·음성 케이스를 `__tests__/infer.test.ts`에 둔다. 픽스처는 `__tests__/fixtures/infer-rows.ts`

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
- `types.ts` — `TopologyGraph` (vpcs, subnets, nodes, edges, meta), 17 `NodeKind`s, `Tier`, 9 `EdgeKind`s (4 explicit + 5 inferred), `TopologyEdgeMeta`, constant arrays and type guards
- `filter.ts` — `TopologyFilter`, `DEFAULT_FILTER`/`createDefaultFilter`, `applyFilter` (pure), `mergeFilter` (patch merge), `filterToSearchParams`/`filterFromSearchParams` (URL round trip), `resolveVpcId`
- `infer.ts` — `inferEdges(input, graph)`: normalised configuration facts → the five inferred edge kinds (`allows`, `permits`, `endpoint`, `triggers`, `origin`). Pure; the rules live nowhere else. Plus `withInferredEdges`, `cidrContains` and the ARN / domain parsers. ADR-014
- `validate.ts` — `validateGraph(g): string[]`; empty = valid. Used on fixture upload and in adapter tests
- `anonymize.ts` — `anonymizeGraph(g, { seed, accountId })` turns a live graph into a shareable fixture: account id, Name tags, resource ids, IPs and CIDRs become seed-derived stand-ins and `meta.anonymized` is set
- `adapters/live.ts` — Steampipe relationship rows → `TopologyGraph`. The only place that knows column names
- `adapters/generator.ts` — `generateGraph(params, opts)`, `PRESETS` (small/medium/large/stress), `mulberry32`, `normalizeParams`. Seeded, deterministic synthesis
- `adapters/fixture.ts` — `parseFixture` (validates, then pins `meta.source='fixture'`), `BUILT_IN_FIXTURES`, `toFixtureJson` (export, optional anonymization)
- `fixtures/` — `plick-prod.json` (anonymized; 2 VPC, 24 subnets, 390 EC2, 2,097 edges) and `stress-1000.json` (2 VPC, 32 subnets, 1,001 EC2, 7,026 edges). Rebuild with `npm run fixtures:build` (`scripts/build-topology-fixtures.ts`)
- `__tests__/` — vitest. `fixtures/live-rows.ts` (synthetic rows plus `liveInferRows`), `fixtures/infer-rows.ts` (a small account for the inference rules), `fixtures/fossflow-expected.json` (snapshot from the pre-Phase-1 generator)
- `layout3d.ts` — `computeLayout(graph, { clusterThreshold, expanded })` → `Layout3D` (VPC plates, AZ lanes, tier bands, subnet platforms, node / stack positions, folded edges, labels, anchors, bounds, stats). Pure and deterministic. ADR-012
- `chat.ts` — pure side of the filter chat: `summarizeGraph`, `buildSystemPrompt`, `SET_FILTER_TOOL`, `sanitizePatch`/`sanitizeFilter`/`sanitizeSummary`/`toConverseMessages`, `createConverseReducer`, `diffFilter`. ADR-013
- `sse.ts` — SSE encoder / decoder shared by the route and ChatPanel

## Contract summary
- **Node id**: the AWS resource id when one exists (`i-…`, `nat-…`, `igw-…`, `tgw-attach-…`, `vpce-…`), else `${kind}:${name}` (`alb:prod-alb`, `rds:prod-db`, `lambda:fn`, `s3:bucket`)
- **Account-global kinds** (`GLOBAL_KINDS`: s3, dynamodb, cloudfront, route53) have no `vpcId` and are hidden in `DEFAULT_FILTER.kinds`
- **Edge endpoints** are node, subnet, or VPC ids; an edge disappears with either endpoint
  - **Explicit** (`EXPLICIT_EDGE_KINDS`, no `meta.derived`): `target` (LB→instance), `route` (subnet→nat/igw/tgw), `attach` (igw/tgw→VPC), `egress` (nat→igw)
  - **Inferred** (`DERIVED_EDGE_KINDS`, `meta.derived` always set): `allows` (a security group opens the path; `meta.ports`, `protocol`), `permits` (IAM data access; `meta.actions`, `roleArn`), `endpoint` (subnet→VPC endpoint), `triggers` (event→Lambda; `meta.disabled`), `origin` (CloudFront / Route 53). **A permitted path, not observed traffic** — drawn dashed
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
- `edgeKinds` (nine, all on by default) hides a kind of line; the endpoint nodes stay
- `showConnectedGlobals` (on by default) keeps a hidden global kind when a **visible edge** reaches something on screen. One pass, no transitive closure; every non-kind condition (query, az) still applies
- URL carries only non-default entries: `vpc`, `tiers` (enabled), `hide`/`show`, `hideEdges` (edge kinds that are off), `globals=0`, `az`, `empty=1`, `q`

## Generator and anonymizer
- **Determinism is the contract.** The same `(params, seed, opts.now)` yields the same graph. There is one PRNG (`mulberry32`) and changing the order of its calls changes the output; the check is that regenerating the fixtures produces no diff
- `PRESETS.stress` is the plan's success criterion (1,000+ EC2, 30+ subnets, 2 VPCs) and must build in under 100ms. Tests assert both
- `ec2PerSubnet` applies to private subnets; public subnets use `ec2PerPublicSubnet` (default `[0, 2]`) so they hold bastions and little else
- Out-of-range params are clamped by `normalizeParams`, never rejected
- Anonymization replaces **identity only**. AWS vocabulary (`m6i.large`, `internet-facing`, `aurora-mysql`, `ap-northeast-2a`, ARN keywords) survives untouched: stand-ins are minted from Name tags, and meta strings only apply stand-ins that already exist
- A private IP moves only its second octet, so subnet CIDRs stay inside their VPC CIDR; public IPs become `203.0.113.0/24` addresses
- `validateGraph` must still return an empty array after anonymization (referential integrity). Edge ids are rebuilt from their endpoints
- Inferred-edge `meta` survives: only the role ARN is rewritten, while `actions` (`s3:GetObject`), `ports`, `protocol` and `derived` are AWS vocabulary and stay

## 3D layout (`layout3d.ts`)
- The renderer computes no positions; position, size, labels and edge endpoints all come from `Layout3D`
- Placement: VPCs side by side on X, AZs as X lanes inside a VPC, tiers on Z (public at +z, toward the camera). The grid on a subnet platform is grouped by kind (`NODE_KINDS` order)
- Subnet-less VPC nodes go to service rows: front (igw, tgw, internet-facing LBs) · middle (internal LBs, endpoints, eks, everything else) · back (rds, elasticache, msk, opensearch). Account-global nodes go to one of three trays (`trays[]`): a band in **front** of the VPCs (+z) for connected CloudFront / Route 53, a band **behind** them (-z) for connected S3 / DynamoDB, and the **side** tray on the right for everything nothing points at
- **Clustering**: more than `clusterThreshold` (default 24; disabled when <= 0) same-kind nodes in one subnet fold into one stack (`${subnetId}:${kind}`). Members anchor to the stack top and `clusterOf` maps back. Edges sharing an anchor pair fold into one, keeping originals in `sourceIds`. `expanded` is UI state, not filter state
- An edge is two segments `from → mid → to`; `mid` is lifted in proportion to distance (0.6–4), plus a per-kind offset (`EDGE_LIFT`) and a deterministic per-edge variation (`LAYOUT.edgeJitter`, max 0.135, below the 0.2 per-kind step) so neither two kinds between the same anchors nor two arcs crossing the same place share a plane
- **Edges fold twice**: stacks first, then subnets when `edgeFoldThreshold` (default 3; <= 1 disables) nodes of one subnet share the same inferred edge. **Explicit relationships never fold this way.** Originals stay in `sourceIds`
- `edgeIndexByElement` (element id → indices into `edges`) is how a renderer that knows nothing about folding finds the lines touching a selection; a folded edge's `fromId` / `toId` need not be the id that was clicked
- `bounds.radius` is never 0 (an empty graph gives 1); camera fitting relies on it
- All dimensions live in the single `LAYOUT` constant; the overlap / containment tests in `layout3d.test.ts` catch a bad change

## Chat (`chat.ts`, `sse.ts`)
- Chat produces **filter patches only**. The graph never reaches the model; the prompt carries `summarizeGraph(graph, filter)` (VPC list, and for the current VPC its AZs, subnet count per tier, node count per kind). Prompt size is independent of node count
- `SET_FILTER_TOOL` is the JSON schema passed straight into Bedrock `toolConfig`. Kind and tier lists are built from the `types.ts` constants, so a new kind is included automatically
- `sanitizePatch(raw, summary)` validates model output: unknown kinds/tiers are dropped into `rejected`; AZs resolve against the summary by exact then suffix match (`2a`, `a`, only when unique); VPCs by id then name. An AZ list that resolves to nothing is not applied (never blank the scene). `sanitizeFilter`, `sanitizeSummary` and `toConverseMessages` normalise client input on the same principle (user-first alternation, empty assistant text replaced, last 10 turns)
- `createConverseReducer()` folds ConverseStream events (structural type, no SDK import) into text plus tool calls. Tool-input JSON is concatenated from deltas and parsed at `contentBlockStop`
- `diffFilter(before, after)` feeds the "what changed" chips in the UI. AZ order is not a change
- `sse.ts`: `encodeSse(event, data)` / `createSseDecoder()`. Handles chunk boundaries, CRLF, comments and a missing trailing blank line
- The route (`src/app/api/topology3d-chat`) only wires these to Bedrock and a `ReadableStream`. ADR-013

## Configuration inference (`infer.ts`, ADR-014)
- The input is **normalised facts, not Steampipe rows** (`SgRuleFact`, `RoleGrantFact`, `EndpointFact`, `EventSourceFact`, `BucketNotificationFact`, `OriginFact`, `DnsRecordFact`). The live adapter maps rows onto them and the generator synthesises the same shapes, so both sources go through the same rules
- Three folding rules: `Resource: "*"` draws nothing and becomes a `meta.iamWildcard` badge; a rule covering the whole VPC CIDR folds onto the VPC anchor; `0.0.0.0/0` anchors on the internet gateway
- Repeated `(from, to, kind)` is one edge; `ports` and `actions` accumulate on it (3306 and 6379 on one line)
- Control-plane actions (`s3:ListAllMyBuckets`, `dynamodb:DescribeTable`) are not a request path and are excluded
- An endpoint that is not in the graph produces no edge, so `validateGraph` still passes after `withInferredEdges`
- Domain matching requires an **exact** match against an ALB `dns_name` or an S3 bucket domain; custom origins stay unconnected
- Every rule needs a positive and a negative case in `__tests__/infer.test.ts`; fixtures in `__tests__/fixtures/infer-rows.ts`

## Rules
- Everything here is **pure**. Inject time via `opts.now`. No network or fs access
- A new source is one new adapter. Never touch renderer or filter for it
- If a FossFLOW generator change breaks `fossflow-parity.test.ts`, inspect the visual difference before regenerating the snapshot
- Verify with `npm test` (vitest, `vitest.config.ts`)
