# ADR-014: 설정 추론 흐름 — 허용된 경로를 선으로 잇는다

- 상태: 채택 (2026-09-10, Phase 4.6)
- 관련: ADR-010 (TopologyGraph 계약), ADR-012 (3D 레이아웃·렌더링), ADR-013 (필터·URL·채팅), `docs/plans/2026-09-10-topology-inferred-flows.md`

## 맥락

3D 뷰는 AWS가 **관계로 기록해 둔 것**만 그렸다. 타겟 그룹(ALB → EC2), 라우트 테이블(서브넷 → NAT/IGW/TGW), 어태치먼트(IGW·TGW ↔ VPC) 셋이다. 그래서 요청이 실제로 지나가는 길 — Route 53 → CloudFront → ALB → 프론트 EC2 → 내부 ALB → 백엔드 EC2 → RDS/ElastiCache/S3/DynamoDB — 은 중간이 끊겨 보이고, S3·DynamoDB는 선 없는 트레이에 떨어져 있었다.

"A가 B를 호출한다"는 레코드는 AWS 어디에도 없다. 그것을 알려면 VPC Flow Logs·X-Ray 같은 관측 데이터가 필요하고, 그건 로그 저장 비용과 집계 파이프라인을 부른다. 반면 **허용된 경로**는 이미 갖고 있는 설정에서 추론할 수 있다. 보안그룹이 누구에게 열려 있는지, IAM 롤이 어느 버킷을 읽을 수 있는지, 어느 서브넷이 S3 엔드포인트를 타는지, 무엇이 Lambda를 트리거하는지, CloudFront가 어디를 오리진으로 두는지가 그것이다.

## 결정

1. **추론 엣지 5종을 신설한다.** `EdgeKind`가 4종에서 9종이 된다. 기존 4종(`target` `route` `attach` `egress`)은 `EXPLICIT_EDGE_KINDS`, 신설 5종은 `DERIVED_EDGE_KINDS`다.

   | 종류 | 의미 | 근거 |
   |---|---|---|
   | `allows` | 보안그룹 인그레스 규칙이 연 A → B | `aws_vpc_security_group_rule` + 각 리소스의 SG |
   | `permits` | IAM 롤이 허용한 데이터 접근 | 인스턴스 프로파일·Lambda 롤의 Allow 구문 |
   | `endpoint` | 서브넷 → VPC 엔드포인트 | `aws_vpc_endpoint`의 라우트 테이블·서브넷 연결 |
   | `triggers` | 이벤트가 Lambda를 호출 | 이벤트 소스 매핑, 버킷 알림 설정 |
   | `origin` | 엣지 서비스가 가리키는 대상 | CloudFront 오리진 도메인, Route 53 레코드 |

2. **"열려 있는 길"이지 "지나간 트래픽"이 아니다.** 관측 데이터(Flow Logs, X-Ray, ADOT, CloudWatch)는 쓰지 않는다. 화면에서도 구분한다: 추론 엣지는 **점선**(튜브 셰이더가 곡선 길이 기준으로 잘라 낸다)이고, 범례는 "명시 관계 / 설정 추론" 두 묶음이며 추론 묶음에 "허용된 경로이며 실제 트래픽이 아님" 한 줄이 붙는다. 데이터에는 `meta.derived = 'sg' | 'iam' | 'endpoint' | 'event' | 'dns'`가 남는다.

3. **규칙은 순수 함수 하나에 모은다.** `src/lib/topology/infer.ts`의 `inferEdges(input, graph)`가 규칙 5개를 전부 갖는다. 입력은 Steampipe 행이 아니라 **정규화된 사실**(`SgRuleFact`, `RoleGrantFact`, `EndpointFact`, `EventSourceFact`, `BucketNotificationFact`, `OriginFact`, `DnsRecordFact`)이다. 라이브 어댑터는 행을 그 형태로 옮기고, 생성기는 같은 형태를 합성한다. 그래서 규칙 버그는 두 소스에서 똑같이 드러나고 테스트 한 벌이 둘을 덮는다.

4. **노이즈를 줄이는 접기 규칙 셋.**
   - `Resource: "*"`는 선을 만들지 않는다. 계정의 모든 버킷과 이어져 그림이 무의미해진다. 노드 배지(`meta.iamWildcard`)로만 표시한다. 관리형 정책(`AmazonS3ReadOnlyAccess`)이 대부분 여기 걸린다
   - VPC CIDR 전체를 덮는 CIDR 규칙은 서브넷마다 긋지 않고 **VPC 앵커** 하나로 접는다. 한 서브넷 CIDR을 덮으면 그 서브넷에서 긋는다
   - `0.0.0.0/0`은 **IGW를 출발점**으로 둔다. 인터넷에서 들어온다는 뜻이고 그 지점이 IGW다
   - 같은 `(from, to, kind)`는 엣지 하나다. 포트와 IAM 액션은 그 위에 쌓인다(3306·6379가 한 선에 붙는다)

5. **컨트롤 평면 액션은 데이터 평면이 아니다.** `s3:ListAllMyBuckets`·`dynamodb:DescribeTable` 같은 액션은 요청 경로를 말해 주지 않으므로 선을 만들지 않는다. `s3:*`·`s3:GetObject`·`dynamodb:Query` 계열만 본다.

6. **`showConnectedGlobals`(기본 켬)가 트레이 문제를 푼다.** 계정 전역 종류(S3·DynamoDB·CloudFront·Route 53)는 수백 개가 될 수 있어 기본 숨김을 유지한다. 다만 **보이는 엣지가 닿는** 전역 노드는 종류가 꺼져 있어도 남긴다. 한 번만 훑고 전이 폐포는 만들지 않는다(전역 → 전역으로 두 홉 들어가지 않는다). 결과적으로 "S3가 나타나는 조건 = 선이 있을 때"가 된다.

7. **레이아웃이 흐름을 앞뒤로 읽히게 한다.** 선이 닿는 전역 노드는 종류에 따라 나뉜다. Route 53·CloudFront는 VPC 앞(+z, 인터넷 쪽) 띠, S3·DynamoDB는 뒤(-z, 프라이빗 티어 너머) 띠, 선이 없는 나머지는 지금처럼 오른쪽 트레이다(`Layout3D.trays[]`, `role: 'front' | 'back' | 'side'`). 엣지 중간점은 종류마다 다른 높이로 띄워 같은 두 앵커를 잇는 명시 엣지와 추론 엣지가 겹치지 않는다.

8. **추론 엣지는 서브넷 단위로 한 번 더 접는다.** 한 서브넷의 노드 여럿(`edgeFoldThreshold`, 기본 3)이 같은 추론 엣지(같은 종류, 같은 반대편)를 가지면 그 끝을 서브넷 앵커로 옮긴다. SG 규칙 하나 뒤에 인스턴스 12대가 있으면 12개 선이 아니라 서브넷에서 나가는 선 하나다 — 설정이 말하는 것도 그것이다(그 인스턴스들은 같은 SG·같은 롤을 공유한다). **명시 관계는 접지 않는다**: "어느 인스턴스가 이 ALB의 타겟인가"는 인스턴스 단위 사실이다. 스택 접힘(클러스터)이 먼저 적용되고 그 위에 서브넷 접힘이 온다. `medium` 실측 190/643, 보안그룹 허용 307 → 55, IAM 허용 220 → 19.
   같은 곳을 지나는 두 호가 같은 평면에 겹치지 않도록 엣지마다 결정적 높이 변화(`LAYOUT.edgeJitter`, 최대 0.135)를 더한다. 종류별 간격(0.2)보다 작아 종류 순서는 유지된다.
9. **접힘을 렌더러가 몰라도 되도록 색인을 함께 낸다.** `Layout3D.edgeIndexByElement`는 요소 id(노드·스택 멤버·서브넷·VPC) → `edges` 인덱스다. 스택이나 서브넷으로 접힌 엣지의 `fromId`/`toId`는 클릭된 id와 다를 수 있으므로, 선택에 닿는 선을 찾는 일은 레이아웃이 맡는다. 툴바의 **"연결선만"** 토글은 이 색인으로 지오메트리 자체를 좁힌다(어둡게가 아니라 그리지 않음). 선택이 없으면 아무 효과가 없다.
10. **필터는 ADR-013 경로 그대로다.** `TopologyFilter.edgeKinds`(9종, 기본 전부 켬)와 `showConnectedGlobals`가 늘고, URL은 기본과 다를 때만 `hideEdges=allows,permits`·`globals=0`을 쓴다. 채팅 `set_filter` 스키마·프롬프트·`sanitizePatch`·`diffFilter`에도 같은 두 필드가 들어간다. 체크박스·URL·채팅 셋은 여전히 같은 `mergeFilter`를 지난다.

11. **IAM은 좁혀서 2·3차로 조회한다.** 계정의 롤 전체를 읽으면 롤 하나당 API 호출 하나다. 1차 조회 결과에서 인스턴스 프로파일·Lambda가 실제로 쓰는 롤 ARN을 뽑아 `WHERE arn IN (…)`으로 2차, 그 롤들이 붙인 관리형 정책 ARN으로 3차를 던진다(`arn`은 두 테이블 모두 키 컬럼이라 Steampipe가 AWS 쪽으로 내려보낸다). 정책 파싱은 서버가 아니라 어댑터에서 한다 — 행은 이미 클라이언트에 오고, 규칙이 순수 함수라 테스트하기 쉽다. IAM 조회가 실패해도 치명적이지 않다: `permits` 엣지만 빠지고 나머지 그래프는 그대로다.

12. **읽기 전용 Describe/List/Get만 쓴다.** 추가 인프라도 추가 비용도 없다. 신설 쿼리는 `aws_vpc_security_group_rule`(인그레스만), `aws_iam_instance_profile`, `aws_iam_role`(좁힘), `aws_iam_policy`(좁힘), `aws_lambda_event_source_mapping`, `aws_route53_record`(A/AAAA/CNAME만) 여섯 개와 기존 쿼리의 컬럼 추가다.

## 결과

- 생성기 `medium`에서 Route 53 → CloudFront → ALB → EC2(web) → 내부 ALB → EC2(api) → RDS·ElastiCache·MSK·OpenSearch·S3·DynamoDB가 끊김 없이 이어진다. `infer.test.ts`의 BFS 테스트가 이를 지킨다
- 규모는 접기로 흡수된다. `stress`에서 그래프 엣지는 2,939개지만 접힘 뒤 화면 엣지는 260개, `medium`은 643 → 190이다. 레이아웃 4ms 이내, `medium` 실측 드로우 콜 37 (상한 50), 삼각형 79,648 → 25,280
- 서브넷 접힘의 대가: 인스펙터에서 개별 인스턴스를 골라도 화면의 선은 서브넷에서 출발한다. `sourceIds`에 원본 엣지가 남고 `edgeIndexByElement`가 멤버를 그 선에 이어 주므로 선택 강조와 "연결선만"은 정상 동작한다. 인스턴스 단위 선을 보려면 `edgeFoldThreshold`를 올리거나 1로 끈다
- 픽스처가 커졌다: `stress-1000.json` 415KB → 1.8MB, `plick-prod.json` 277KB → 855KB. 기계만 읽는 파일이고 `npm run fixtures:build`로 결정적으로 재생성된다
- 익명화는 여전히 식별 정보만 바꾼다. SG id·롤 ARN의 계정 ID·버킷 이름·도메인은 치환되고, `meta.actions`의 AWS 액션 이름(`s3:GetObject`)·포트·프로토콜·`derived`는 그대로 남는다
- 한계(의도한 것): IAM 정책 시뮬레이션을 하지 않는다. Deny·조건·리소스 정책 교차 평가는 없고 명시 Allow의 리소스 ARN만 본다. 계정 간(TGW 너머) 흐름도 범위 밖이다. 도메인 매칭은 ALB `dns_name`·S3 버킷 도메인과 **정확히 일치**할 때만 — 커스텀 오리진 도메인은 잇지 않는다
- 한계(측정 못 함): PLick 계정 대조 검증은 아직 하지 않았다. 코드 경로는 합성 행(`__tests__/fixtures/infer-rows.ts`, `live-rows.ts`의 `liveInferRows`)으로 덮여 있고 컬럼명은 로컬 Steampipe `information_schema.columns`로 확인했지만, 실제 계정의 `inline_policies_std` 모양과 `aws_route53_record`의 무한정 조회는 실계정에서 한 번 확인해야 한다

---

# ADR-014: Inferred Flows from Configuration — Drawing the Permitted Path (English)

- Status: accepted (2026-09-10, Phase 4.6)
- Related: ADR-010 (TopologyGraph contract), ADR-012 (3D layout and rendering), ADR-013 (filter, URL, chat), `docs/plans/2026-09-10-topology-inferred-flows.md`

## Context

The 3D view drew only what AWS **records as a relationship**: target groups (ALB → EC2), route tables (subnet → NAT/IGW/TGW) and attachments (IGW/TGW ↔ VPC). The path a request actually travels — Route 53 → CloudFront → ALB → front-end EC2 → internal ALB → back-end EC2 → RDS/ElastiCache/S3/DynamoDB — broke in the middle, and S3 and DynamoDB sat in a tray with no line reaching them.

No AWS API records "A calls B". Learning that needs observed traffic (VPC Flow Logs, X-Ray), which means log storage cost and an aggregation pipeline. The **permitted path**, on the other hand, is already in the configuration we hold: which security group is open to whom, which bucket an IAM role can read, which subnet reaches S3 through an endpoint, what invokes a Lambda, where a CloudFront distribution points.

## Decision

1. **Five inferred edge kinds.** `EdgeKind` goes from four to nine: the original four are `EXPLICIT_EDGE_KINDS`, the new five `DERIVED_EDGE_KINDS` — `allows` (a security-group ingress rule opens A → B), `permits` (an IAM role allows a data action on a bucket or table), `endpoint` (a subnet reaches a service through a VPC endpoint), `triggers` (an event source invokes a Lambda) and `origin` (CloudFront / Route 53 points at a target).
2. **A permitted path, never observed traffic.** No Flow Logs, X-Ray, ADOT or CloudWatch. The screen says so too: inferred edges are **dashed** (the tube shader cuts the gaps by arc length), the legend splits into "explicit relationships" and "inferred from configuration", and the inferred group carries the line "dashed lines are permitted paths, not observed traffic". In the data every inferred edge has `meta.derived`.
3. **One pure function holds every rule.** `inferEdges(input, graph)` in `src/lib/topology/infer.ts`. Its input is **normalised facts**, not Steampipe rows; the live adapter maps rows onto them and the generator synthesises the same shapes. A bug in a rule therefore shows up identically in both sources, and one set of tests covers both.
4. **Three folding rules keep the noise down.** `Resource: "*"` draws nothing (it would connect an instance to every bucket in the account) and becomes a node badge instead; a CIDR rule covering the whole VPC folds onto the VPC anchor rather than one line per subnet; `0.0.0.0/0` anchors on the internet gateway. Repeated `(from, to, kind)` pairs are one edge that accumulates ports and actions.
5. **Control-plane actions are not data-plane.** `s3:ListAllMyBuckets` and friends say nothing about a request path and draw nothing.
6. **`showConnectedGlobals` (default on) fixes the tray.** Account-global kinds stay hidden by default (an account can hold hundreds), but a global node a **visible edge reaches** is kept even while its kind is off. One pass, no transitive closure. "S3 appears exactly when something points at it."
7. **The layout reads front to back.** Connected globals split by kind: Route 53 and CloudFront into a band in front of the VPCs (+z, the internet side), S3 and DynamoDB into a band behind them (-z), everything unconnected into the existing side tray (`Layout3D.trays[]`). Edge midpoints lift by kind so an inferred edge never hides under the explicit one joining the same anchors.
8. **Inferred edges fold once more, onto subnets.** When several nodes of one subnet (`edgeFoldThreshold`, default 3) carry the same inferred edge (same kind, same other end), that end moves to the subnet anchor. Twelve instances behind one security-group rule are one line from their subnet, which is also what the configuration says — those instances share the group and the role. **Explicit relationships never fold this way**: "which instance is a target of this ALB" is a per-instance fact. Stack folding applies first, subnet folding on top. Measured on `medium`: 190 drawn of 643, `allows` 307 → 55, `permits` 220 → 19. A deterministic per-edge height variation (`LAYOUT.edgeJitter`, at most 0.135) keeps two arcs crossing the same patch of sky out of one plane; it is smaller than the per-kind step (0.2), so that ordering survives.
9. **The layout also emits an index, so the renderer need not know about folding.** `Layout3D.edgeIndexByElement` maps an element id (node, clustered member, subnet, VPC) to indices into `edges`, because a folded edge's `fromId` / `toId` is not necessarily the id that was clicked. The toolbar's **focus** toggle uses that index to narrow the geometry itself — unrelated lines are not drawn rather than dimmed — and does nothing until something is selected.
10. **Filtering follows ADR-013 exactly.** `TopologyFilter` gains `edgeKinds` (nine, all on) and `showConnectedGlobals`; the URL carries `hideEdges=` and `globals=0` only when they differ from the default; the chat's `set_filter` schema, prompt, `sanitizePatch` and `diffFilter` gain the same two fields. Checkboxes, URL and chat still share one `mergeFilter`.
11. **IAM is fetched narrowed, in two extra passes.** Reading every role in an account is one API call per role. Pass one finds the role ARNs instance profiles and Lambdas actually use; pass two fetches those roles with `WHERE arn IN (…)`; pass three fetches the managed policies they attach (`arn` is a key column on both tables, so Steampipe pushes the list down to AWS). Policy parsing happens in the adapter, not the server: the rows are already on the client and the rules stay pure and testable. A failure in the IAM passes costs only the `permits` edges.
12. **Read-only Describe/List/Get only.** No new infrastructure and no new cost. Six new queries plus added columns on existing ones.

## Consequences

- In the generator's `medium` preset the whole path connects, end to end; a BFS test in `infer.test.ts` guards it
- Scale is absorbed by folding: `stress` has 2,939 graph edges but 260 on screen, and `medium` 643 → 190. Layout stays under 4ms; measured draw calls on `medium` 37 (cap 50) and triangles 79,648 → 25,280
- The price of subnet folding: picking one instance in the inspector still shows a line leaving its subnet. `sourceIds` keeps the originals and `edgeIndexByElement` ties each member to that line, so highlighting and focus mode still work. Raise `edgeFoldThreshold` (or set it to 1) for per-instance lines
- Fixtures grew: `stress-1000.json` 415KB → 1.8MB, `plick-prod.json` 277KB → 855KB. Machine-read files, regenerated deterministically by `npm run fixtures:build`
- Anonymisation still replaces identity only: SG ids, the account id inside a role ARN, bucket names and domains move; AWS action names, ports, protocols and `derived` survive
- Deliberate limits: no IAM policy simulation (no Deny, conditions or resource-policy evaluation — only the resource ARNs of explicit Allows), no cross-account flows, and domain matching requires an **exact** match against an ALB `dns_name` or an S3 bucket domain
- Not yet measured: the PLick account has not been cross-checked. Column names were verified against the local Steampipe `information_schema.columns` and every code path is covered by synthetic rows, but the real shape of `inline_policies_std` and the cost of an unqualified `aws_route53_record` listing still need one look at a live account
