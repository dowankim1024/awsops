# 3D 토폴로지 · 설정 추론 흐름 계획 (Phase 4.6)

작성일 2026-09-10 · 대상 리포 `dowankim1024/awsops` · 브랜치 `feature/topology-3d` · 선행: `2026-09-09-topology-3d-and-slimdown.md`, ADR-010 / 012 / 013

## 0. 문제와 목표

지금의 3D 뷰는 AWS 설정 API에 **관계로 명시된 것**만 선으로 그린다. 타겟 그룹(ALB → EC2), 라우트 테이블(서브넷 → NAT / IGW / TGW), 어태치먼트(IGW·TGW ↔ VPC) 세 종류다.
그래서 요청이 실제로 지나가는 길 — Route 53 → CloudFront → ALB → 프론트 EC2 → 내부 ALB → 백엔드 EC2 → RDS / ElastiCache / S3 / DynamoDB — 은 끊겨 보이고, S3·DynamoDB는 트레이에 떨어져 있다.

"A가 B를 호출한다"는 레코드는 AWS 어디에도 없다. 그러나 **허용된 경로**는 설정에서 추론할 수 있다. 보안그룹이 누구에게 열려 있는지, IAM 롤이 어느 버킷을 읽을 수 있는지, 어느 서브넷이 S3 엔드포인트를 타는지, 무엇이 Lambda를 트리거하는지, CloudFront가 어디를 오리진으로 두는지가 그것이다.

이 계획은 **읽기 전용 Describe/List/Get 호출만으로** 추론 엣지 5종을 더해 요청 경로 전체를 잇는다. 추가 인프라와 추가 비용은 없다.

### 성공 기준

| 항목 | 목표 |
|---|---|
| 경로 | 생성기 `medium`에서 Route 53 → CloudFront → ALB → EC2 → 내부 ALB → EC2 → RDS/ElastiCache, EC2 → S3/DynamoDB, S3 → Lambda 가 끊김 없이 이어진다 |
| 라이브 | PLick 계정에서 내부 ALB · RDS · S3 게이트웨이 엔드포인트 엣지가 실제 SG·라우트 설정과 일치한다 (수동 대조 3건 이상) |
| 규모 | `stress` 프리셋에서 60fps 유지, 드로우 콜 50 이하 유지. 추론 엣지는 스택 단위로 접혀 화면 엣지 수가 노드 수에 비례하지 않는다 |
| 정확성 | 추론 규칙은 순수 함수 `inferEdges(rows)`이고 vitest로 규칙마다 양성·음성 케이스가 있다 |
| 신뢰 표시 | 화면과 인스펙터에서 "명시 관계"와 "설정 추론"이 구분된다 (선 스타일 + `meta.derived`) |
| 필터·채팅 | 엣지 종류 필터가 체크박스·URL·채팅 세 경로에서 같은 결과를 낸다 (ADR-013 유지) |
| 비용 | Steampipe 조회 외 AWS 호출 없음. Flow Logs, X-Ray, CloudWatch Logs 미사용 |

### 비목표

- **관측 트래픽**(VPC Flow Logs, X-Ray, ADOT). 로그 저장 비용과 집계 파이프라인이 필요하다. 추론 엣지는 "열려 있는 길"이지 "지나간 트래픽"이 아니며, 화면에도 그렇게 표기한다
- 트래픽 양에 따른 선 굵기·속도. CloudWatch 메트릭 연동은 별도 계획
- IAM 정책 시뮬레이션(`SimulatePrincipalPolicy`). Deny·조건·리소스 정책 교차 평가는 하지 않는다. 명시 Allow의 리소스 ARN만 본다
- 계정 간(TGW 너머) 흐름. 단일 계정 범위

---

## 1. 추론 규칙

모든 규칙은 Steampipe 행 → `TopologyEdge[]`의 순수 함수다. 컬럼명은 로컬 Steampipe `information_schema.columns`로 확인했다(2026-09-10, aws 플러그인).

| 신설 `EdgeKind` | 의미 | 근거 테이블 · 컬럼 | 규칙 |
|---|---|---|---|
| `allows` | 보안그룹이 열어 준 경로 (A → B) | `aws_vpc_security_group_rule`: `group_id`, `is_egress`, `referenced_group_id`, `cidr_ipv4`, `from_port`, `to_port`, `ip_protocol` · 각 리소스의 SG: `aws_ec2_instance.security_groups`, `aws_ec2_application_load_balancer.security_groups`, `aws_rds_db_instance.vpc_security_groups`, `aws_elasticache_cluster.security_groups`, `aws_opensearch_domain.vpc_options`, `aws_msk_cluster.provisioned`, `aws_lambda_function.vpc_security_group_ids` | 대상 B의 SG에 **인그레스** 규칙(`is_egress = false`)이 있고 `referenced_group_id`가 A의 SG면 A → B. `cidr_ipv4`만 있고 그 CIDR이 서브넷 CIDR을 **포함**하면 서브넷 → B (노드가 아닌 서브넷을 출발점으로). `0.0.0.0/0`은 퍼블릭 티어 노드(internet-facing LB)에만 의미가 있으므로 "인터넷 → B"로 IGW를 출발점에 둔다. `meta: { ports: '3306', protocol: 'tcp', sgRuleId }` |
| `permits` | IAM 롤이 허용한 데이터 접근 (A → S3/DynamoDB) | `aws_ec2_instance.iam_instance_profile_arn` → `aws_iam_instance_profile.roles` → `aws_iam_role.inline_policies_std`, `attached_policy_arns` → `aws_iam_policy.policy_std` · `aws_lambda_function.role` | 정책 문서 `Statement[]`에서 `Effect = Allow`이고 `Action`이 `s3:*`·`s3:GetObject`·`s3:PutObject`·`dynamodb:*`·`dynamodb:GetItem`·`dynamodb:Query`… 계열이며 `Resource`가 **명시 ARN**(`arn:aws:s3:::bucket`, `arn:aws:s3:::bucket/*`, `arn:aws:dynamodb:…:table/name`)이면 A → 그 버킷/테이블. `Resource = "*"`는 엣지를 만들지 않고 노드 `meta.iamWildcard = true`로만 표시한다(노이즈 방지). `meta: { roleArn, actions: ['s3:GetObject'] }` |
| `endpoint` | VPC 엔드포인트 경유 (서브넷 → S3/DynamoDB) | `aws_vpc_endpoint`: `vpc_endpoint_id`, `service_name`, `vpc_endpoint_type`, `route_table_ids`, `subnet_ids` · `aws_vpc_route_table`(기존 쿼리)의 서브넷 연결 | Gateway 타입(`com.amazonaws.<region>.s3`, `.dynamodb`)이면 `route_table_ids`에 연결된 서브넷 → 엔드포인트 노드 → 서비스(전역 노드 `s3:*`가 아닌 **서비스 대표 노드**, §2). Interface 타입이면 `subnet_ids`의 서브넷 → 엔드포인트 노드. 기존 `endpoint` 노드를 재사용하고 엣지만 더한다 |
| `triggers` | 이벤트가 Lambda를 호출 (S3/DynamoDB/MSK → Lambda) | `aws_lambda_event_source_mapping`: `arn`(이벤트 소스 ARN), `function_arn`, `state` · `aws_s3_bucket.event_notification_configuration` · `aws_dynamodb_table.latest_stream_arn` | 매핑의 소스 ARN이 DynamoDB 스트림이면 테이블 → Lambda, MSK 클러스터면 MSK → Lambda. S3는 매핑이 아니라 버킷의 `event_notification_configuration.LambdaFunctionConfigurations[].LambdaFunctionArn`으로 버킷 → Lambda. `state <> 'Enabled'`는 `meta.disabled = true`로 그리되 흐림 처리 |
| `origin` | 엣지 서비스가 가리키는 대상 (Route 53 → CloudFront/ALB, CloudFront → S3/ALB) | `aws_cloudfront_distribution.origins[].DomainName` · `aws_route53_record`: `type`, `alias_target.DNSName`, `records` · ALB `dns_name`, S3 버킷 도메인 `<name>.s3.<region>.amazonaws.com` / `<name>.s3.amazonaws.com` | 오리진 도메인이 ALB `dns_name`과 같으면 CloudFront → ALB, S3 버킷 도메인 패턴이면 CloudFront → 버킷. Route 53 A/AAAA/CNAME 레코드의 alias·값이 CloudFront 도메인(`*.cloudfront.net`)이나 ALB `dns_name`과 같으면 호스팅 존 → 대상. 도메인 비교는 소문자·끝 점 제거 |

규칙 공통:
- 출발·도착 노드가 그래프에 없으면 엣지를 만들지 않는다(예: SG는 있으나 인스턴스가 terminated). `validateGraph`가 이를 보장한다
- 같은 (from, to, kind) 쌍은 하나로 합치고 `meta.ports`·`meta.actions`를 배열로 누적한다. EC2 100대 → RDS 1대는 엣지 100개가 아니라, 레이아웃의 스택 접힘으로 화면에서는 1개다(ADR-012)
- 모든 추론 엣지는 `meta.derived = 'sg' | 'iam' | 'endpoint' | 'event' | 'dns'`를 갖는다. 명시 관계(`target`·`route`·`attach`·`egress`)는 `derived`가 없다

## 2. 데이터 계약 변경 (`src/lib/topology/types.ts`)

```ts
export const EDGE_KINDS = [
  'target', 'route', 'attach', 'egress',            // 기존: 명시 관계
  'allows', 'permits', 'endpoint', 'triggers', 'origin', // 신설: 설정 추론
] as const;

export interface TopologyEdge {
  id: string; from: string; to: string; kind: EdgeKind; label?: string;
  meta?: { derived?: 'sg' | 'iam' | 'endpoint' | 'event' | 'dns'; ports?: string[]; protocol?: string;
           actions?: string[]; roleArn?: string; disabled?: boolean };
}
```

- 노드 `meta`에 추가(모두 선택): ec2 `securityGroups roleArn iamWildcard` · alb/nlb `securityGroups`(이미 있음) · rds/elasticache/msk/opensearch `securityGroups` · lambda `securityGroups roleArn` · s3 `domain` · route53 `records`(개수만)
- **서비스 대표 노드**: 엔드포인트 엣지의 도착점으로 `s3:__service__` 같은 가짜 노드를 두지 않는다. Gateway 엔드포인트 → 개별 버킷은 알 수 없으므로 서브넷 → 엔드포인트 노드까지만 긋고, 엔드포인트 노드의 `meta.serviceName`으로 트레이의 S3 그룹과 같은 색을 쓴다. 버킷별 선은 `permits`(IAM)가 담당한다
- `GLOBAL_KINDS`는 유지한다. 전역 노드는 여전히 `vpcId`가 없고 기본 필터에서 숨겨진다. 다만 **엣지가 붙은 전역 노드**는 필터 `kinds`가 꺼져 있어도 `showConnectedGlobals: true`(신설, 기본 true)면 남긴다. "S3가 떨어져 있다"의 절반은 기본 숨김 때문이다
- `TopologyFilter.edgeKinds: Record<EdgeKind, boolean>` 신설. 기본 전부 true. URL은 `hideEdges=allows,permits`처럼 기본과 다른 것만. 채팅 `set_filter` 스키마에 `edgeKinds` 추가 — 프롬프트·검증(`sanitizePatch`)·diff 칩까지 ADR-013 경로 그대로

## 3. 어댑터

### 3.1 Live (`adapters/live.ts`, `queries/relationships.ts`)

추가 쿼리 7개. 모두 `account_id`를 포함하고 `$`를 쓰지 않는다.

| 키 | 테이블 | 비고 |
|---|---|---|
| `sgRules` | `aws_vpc_security_group_rule` | `referenced_group_id`, `cidr_ipv4`, `is_egress`, 포트·프로토콜 |
| `instanceProfiles` | `aws_iam_instance_profile` | `arn`, `roles` (롤 ARN 배열) |
| `roles` | `aws_iam_role` | `arn`, `inline_policies_std`, `attached_policy_arns` — **인스턴스·Lambda가 쓰는 롤만** `where arn in (…)`으로 좁힌다. 계정의 롤 전체를 읽지 않는다 |
| `policies` | `aws_iam_policy` | `arn`, `policy_std` — 위 롤의 `attached_policy_arns`만 |
| `eventSourceMappings` | `aws_lambda_event_source_mapping` | `arn`, `function_arn`, `state` |
| `bucketNotifications` | `aws_s3_bucket` | `name`, `event_notification_configuration` (기존 `s3Buckets` 쿼리에 컬럼 추가) |
| `route53Records` | `aws_route53_record` | `type in ('A','AAAA','CNAME')`, `alias_target`, `records` |

기존 쿼리에 컬럼 추가: `ec2Relations`에 `security_groups`, `iam_instance_profile_arn` · `rdsRelations`에 `vpc_security_groups` · `elasticache`에 `security_groups` · `lambdaVpc`에 `role`, `vpc_security_group_ids` · `vpcEndpoints`에 `route_table_ids`, `subnet_ids`, `vpc_endpoint_type` · `cloudfrontDists`에 `origins`.

`batchQuery`는 5개씩 순차 실행(30초 타임아웃)이라 쿼리가 18 → 25개가 되면 첫 로딩이 30~60초 늘 수 있다. `cache-warmer`에 관계 쿼리를 넣지 않는 원칙은 유지하고, 대신 `/api/steampipe`의 5분 캐시에 맡긴다. IAM 정책 파싱은 서버가 아닌 어댑터(클라이언트)에서 한다 — 행은 이미 클라이언트로 오고, 규칙이 순수 함수라 테스트하기 쉽다.

### 3.2 Generator (`adapters/generator.ts`)

결정성 계약을 지키며 같은 PRNG 순서 뒤에 추론 엣지를 붙인다(기존 호출 순서 변경 금지 — 픽스처 diff가 생긴다).

- VPC마다 SG 계층 3개를 합성: `web-sg`(퍼블릭 EC2·internet-facing ALB), `app-sg`(프라이빗 EC2·internal ALB), `data-sg`(RDS·ElastiCache·MSK·OpenSearch). 규칙: internet → web-sg:443, web-sg → internal ALB:8080, app-sg → data-sg:3306/6379/9092/443
- 프라이빗 EC2의 일부(시드 기반 40%)에 `permits`로 버킷 1~2개·테이블 0~1개
- S3 게이트웨이 엔드포인트 1개(프라이빗 라우트 테이블 전체 연결), DynamoDB 엔드포인트 0~1개
- Lambda 중 시드 기반 30%에 S3 트리거, 10%에 DynamoDB 스트림
- CloudFront 배포 1~2개: 오리진은 internet-facing ALB 또는 정적 버킷. Route 53 존 1개에 CloudFront·ALB 레코드
- `PRESETS`에 파라미터 추가 없음(내부 비율 상수). `stress`에서 `allows` 엣지가 EC2 수만큼 생기지만 스택 접힘 후 화면 엣지는 수십 개다

### 3.3 Fixture · 익명화

- `npm run fixtures:build`로 `plick-prod.json`·`stress-1000.json` 재생성. 스키마가 바뀌므로 diff가 나는 것이 정상이고, 재생성 후 `validateGraph`와 `fixture.test.ts`가 통과해야 한다
- `anonymize.ts`: SG id(`sg-…`), 롤 ARN의 계정 ID와 롤 이름, 버킷 이름, 도메인 이름을 시드 기반으로 치환한다. `meta.actions`의 AWS 액션 이름(`s3:GetObject`)과 포트 번호는 그대로 둔다 — "식별 정보만 바꾼다" 원칙

## 4. 레이아웃 (`layout3d.ts`, ADR-012 개정)

- **트레이 재배치.** 지금 트레이는 VPC 오른쪽에 있고 선이 없다. 엣지가 붙은 전역 노드(S3·DynamoDB·CloudFront·Route 53)는 **VPC 뒤편(-z, 프라이빗 티어 너머) 트레이**로 옮겨 데이터 흐름이 앞(인터넷) → 뒤(데이터)로 읽히게 한다. 엣지가 없는 전역 노드는 지금처럼 오른쪽에 둔다
- **인터넷 앵커.** `allows`의 `0.0.0.0/0`과 `origin`의 출발점(Route 53·CloudFront)은 VPC 앞쪽(+z) 가장자리의 "인터넷 띠"에 둔다. IGW 옆
- **엣지 접힘 확장.** 같은 (앵커 from, 앵커 to, kind)로 접는 규칙은 그대로. 추론 엣지는 종류가 늘어 `sourceIds`가 커지므로 인스펙터는 처음 20개만 보이고 "외 N개"로 접는다(이미 있는 `MEMBER_PREVIEW` 패턴)
- **엣지 중간점 높이.** 종류별로 띄우는 높이를 달리해 같은 두 앵커를 잇는 명시 엣지와 추론 엣지가 겹치지 않게 한다(`target` 0.6~4 유지, `allows` +0.4, `permits` +0.8)
- 치수는 `LAYOUT` 상수에만 추가. 겹침·포함 테스트가 잡는다

## 5. 렌더·UI

- **선 스타일.** 튜브 하나 유지. 정점 색으로 종류 구분(`EDGE_COLORS`에 5색 추가), 추론 엣지는 셰이더의 `aDir`처럼 `aDerived` 속성을 두어 **점선 패턴**(fract(vT·N) 마스크)으로 그린다. 흐름 애니메이션은 `allows`·`permits`·`triggers`·`origin`에도 방향이 있으니 `DIRECTED_KINDS`에 넣는다
- **범례.** 엣지 종류 9개를 "명시 관계 / 설정 추론" 두 묶음으로 나눠 표시. 추론 묶음에 "허용된 경로이며 실제 트래픽이 아님" 한 줄
- **인스펙터.** 엣지 선택(선 클릭)은 이번에도 지원하지 않는다. 대신 노드 상세의 "연결" 목록에 종류 배지와 `meta.ports`/`actions`를 보여 준다
- **필터 패널.** "엣지" 그룹 추가(체크박스 9개, 명시/추론 묶음 all/none). `showConnectedGlobals` 토글
- **채팅.** 프롬프트의 그래프 요약에 엣지 종류별 개수 추가. "S3까지 흐름 보여줘" → `set_filter({ kinds: { s3: true }, edgeKinds: { permits: true, endpoint: true } })`
- **URL.** `hideEdges=`, `globals=0`

## 6. 파일

### 신규
```
src/lib/topology/infer.ts                  # inferEdges(rows, graph): TopologyEdge[] — 규칙 5개, 순수
src/lib/topology/__tests__/infer.test.ts   # 규칙별 양성·음성, 와일드카드 무시, CIDR 포함, 중복 합침
src/lib/topology/__tests__/fixtures/infer-rows.ts
docs/decisions/014-topology-inferred-flows.md
```

### 수정
`types.ts`(EdgeKind·meta) · `filter.ts`(edgeKinds, showConnectedGlobals, URL) · `chat.ts`(스키마·요약·검증·diff) · `validate.ts`(신규 kind) · `adapters/live.ts` · `adapters/generator.ts` · `anonymize.ts` · `layout3d.ts` · `queries/relationships.ts` · `hooks/useTopologySource.ts`(쿼리 목록) · `components/topology3d/{colors,tubes,Edges,Legend,FilterPanel,Inspector}` · `fixtures/*.json`(재생성) · i18n 3개 · 각 `CLAUDE.md` · README 기능 표

## 7. 단계

| 단계 | 내용 | 완료 기준 | AWS 접근 |
|---|---|---|---|
| A | 계약·필터·`infer.ts` 골격, SG 체이닝(`allows`) + 엔드포인트(`endpoint`), 생성기 합성, 픽스처 재생성 | 생성기 medium에서 프론트 → 내부 ALB → 앱 → RDS가 이어진다. vitest 통과 | 없음 |
| B | IAM(`permits`) + 이벤트(`triggers`), 트레이 재배치, 인터넷 앵커 | EC2 → S3, S3 → Lambda 표시. 레이아웃 테스트 통과 | 없음 |
| C | CloudFront·Route 53(`origin`), 점선 스타일, 범례·필터·채팅·URL, 인스펙터 | 세 경로 필터 동일. 채팅 스키마 테스트 | 없음 |
| D | Live 어댑터 쿼리 7개, 라이브 검증, 익명화 확장, 문서(ADR-014, CLAUDE.md, README) | PLick 계정에서 수동 대조 3건 일치. `plick-prod.json` 갱신 | **로컬 Steampipe 읽기 조회** (Describe/List/Get). 비용 없음. 실행 전 알림 |

A~C는 자격증명 없이 끝난다. D만 실제 계정을 읽는다. Bedrock은 채팅을 실제로 눌러야만 호출되며 이 계획의 검증에는 쓰지 않는다.

## 8. 리스크

| 리스크 | 대응 |
|---|---|
| SG 규칙이 SG 참조가 아니라 CIDR로만 열려 있음 (`10.0.0.0/16` 허용) | CIDR이 서브넷 CIDR을 포함하면 서브넷 → 대상으로 그린다. VPC CIDR 전체면 "VPC → 대상"(VPC 앵커)로 접어 노이즈를 줄인다 |
| IAM `Resource: "*"` 와일드카드가 많아 모든 버킷과 연결됨 | 와일드카드는 엣지를 만들지 않고 노드 배지로만. 명시 ARN만 선으로 |
| 관리형 정책(`AmazonS3ReadOnlyAccess`) 파싱 | `aws_iam_policy.policy_std`는 AWS 관리형도 읽힌다. 다만 대부분 와일드카드라 위 규칙으로 걸러진다 |
| 롤 전체 조회 시 IAM 호출 폭증 | 인스턴스 프로파일·Lambda가 쓰는 롤 ARN으로 `where arn in (…)` 제한. Steampipe는 목록 필터를 API 호출로 내려보낸다 |
| stress에서 `allows` 엣지 수천 개 | 앵커 접힘으로 화면 엣지는 스택 쌍당 1개. `buildTubes`는 접힌 엣지만 받는다. 레이아웃 100ms 기준 테스트 유지 |
| 도메인 매칭 오탐 (CloudFront 오리진이 커스텀 도메인) | ALB `dns_name`·S3 도메인 패턴과 **정확히 일치**할 때만. 안 맞으면 엣지 없이 `meta.originDomain`으로 인스펙터에만 |
| PLick 계정이 작아 라이브에서 추론 엣지가 몇 개 없음 | 생성기·픽스처가 시연용. 라이브는 "실제 설정과 일치함" 증명용 (기존 원칙과 동일) |
| Route 53 레코드 수가 많음 (수백) | A/AAAA/CNAME만, alias나 값이 ALB·CloudFront 도메인과 일치하는 것만 노드화. 나머지는 개수만 |

## 9. 확정 필요 사항

기본값을 정해 두었다. 다르게 가려면 A 단계 전에 바꾼다.

1. **추론 엣지 기본 표시** (기본: 켬, 점선). 처음부터 켜면 화면이 복잡해질 수 있으나 "흐름이 보인다"가 목적이므로 켠다
2. **엣지 붙은 전역 노드 기본 표시** (기본: 켬). S3·DynamoDB가 트레이에 나타나는 조건이 "선이 있을 때"가 된다
3. **와일드카드 IAM 처리** (기본: 선 없음, 배지만). 선을 긋고 싶으면 "모든 버킷" 대표 노드 하나로 접는 방식이 대안
4. **CIDR 규칙의 VPC 전체 허용** (기본: VPC 앵커로 접음)
5. **ADR 번호** 014 (현재 최대 013)
