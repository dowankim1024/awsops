# 3D 토폴로지 뷰 구현 계획 (포크 슬림화 포함)

작성일 2026-09-09 · 대상 리포 `dowankim1024/awsops` (upstream `hojun121/awsops`) · 대상 AWS 계정 PLick (815090125359, ap-northeast-2)

## 0. 목표

수백 대 규모의 AWS 인프라를 3D로 그리고, 체크박스와 자연어 채팅이 **같은 필터 상태**를 조작하는 토폴로지 뷰를 만든다.
라이브 계정 연동과 별개로 픽스처와 합성 생성기를 1급 데이터 소스로 두어, 자격증명 없이도 열리고 규모 테스트가 가능하게 한다.
프론트엔드 포트폴리오가 목적이므로 기여가 git 이력에서 분리되어 보이도록 새 페이지와 새 모듈로 쌓는다.

### 성공 기준

| 항목 | 목표 |
|---|---|
| 규모 | EC2 1,000대, 서브넷 30개, VPC 2개에서 60fps (M 시리즈 Mac, Chrome) |
| 첫 렌더 | 생성기 데이터 기준 1초 이내 |
| 드로우 콜 | 50 이하 (종류별 InstancedMesh) |
| 필터 | 체크박스, URL, 채팅 세 경로가 하나의 `TopologyFilter`를 씀 |
| 데이터 소스 | Live / Fixture / Generator 전환이 렌더러 코드 변경 없이 동작 |
| 오프라인 | AWS 자격증명 없이 Fixture와 Generator 모드가 완전히 동작 |

### 비목표

- AgentCore 기반 AI 어시스턴트(11 라우트, 125 MCP 도구) 복원
- 멀티 어카운트 UI 확장 (코드는 남기되 단일 계정으로 운용)
- 기존 Topology View(FossFLOW)와 2D PNG 탭의 개선
- Docusaurus 가이드 사이트 유지
- 로컬 사전 검증 단계 (바로 구현하고 EC2에서 확인)

---

## 1. Phase 0 · 걷어내기

원칙은 셋이다. **비용이나 인프라를 요구하는 것**, **무신사 환경 고유 정보**, **빌드나 커밋 훅을 막는 것**만 지운다.
휴면 상태로 놔둬도 해가 없는 격리된 기능(K8s 페이지, 데이터소스, 컴플라이언스)은 손대지 않는다. 지우는 데도 시간이 들기 때문이다.

### 1.1 삭제

| 경로 | 이유 |
|---|---|
| `agent/` 전체 | Strands 에이전트 + Lambda 19개. AgentCore 전용 |
| `infra-cdk/lib/agentcore-stack.ts` | AgentCore 인프라 |
| `scripts/04-setup-eks-access.sh` | PLick에 EKS 없음 |
| `scripts/05-setup-cognito.sh` | ALB 인증 미사용 (SSM 포트 포워딩으로 접속) |
| `scripts/06-setup-agentcore.sh`, `06a`~`06f` | AgentCore |
| `scripts/07-setup-opencost.sh`, `07-setup-opencost-interactive.sh` | EKS 비용, 미사용 |
| `scripts/08-setup-cloudfront-auth.sh` | Lambda@Edge 인증, 미사용 |
| `scripts/12-setup-multi-account.sh` | 단일 계정 운용 |
| `src/app/agentcore/`, `src/app/api/agentcore/` | AgentCore 상태 페이지 |
| `src/app/api/code/` | Code Interpreter (AgentCore) |
| `src/app/ai/`, `src/app/api/ai/` | 11 라우트 중 9개가 AgentCore 의존. 1,784줄 재작성보다 제거가 싸다. 필요 시 `aws-data` 라우트만 나중에 복원 |
| `app-demo/` | Istio Bookinfo 데모 |
| `docs/istio-agentops-demo/` | 위 데모 문서 |
| `docs/runbooks/musinsa-deployment.md` | 무신사 계정 ID, 도메인, ExternalId 포함 |
| `.claude/agents/awsops.md` | 무신사 환경 지식. PLick용으로 새로 씀 |
| `.claude/hooks/check-guide-i18n-sync.sh`, `check-menu-guide-sync.sh`, `accumulate-pending-guides.sh` | `web/` 가이드 동기화 강제. 가이드 삭제와 함께 제거 |
| `.claude/skills/sync-guides/` | 동일 |
| `web/` 전체 | Docusaurus 가이드 사이트. 유지 비용 대비 가치 없음 |
| `.github/workflows/deploy-guide.yml` | 가이드 GitHub Pages 배포 |
| `.harness-eval/`, `.kiro/` | 외부 도구 산출물 |
| `docs/reviews/`, `docs/superpowers/` | 이전 세션 리뷰 기록 |

### 1.2 수정

| 경로 | 내용 |
|---|---|
| `CLAUDE.md` | "무신사 배포판" 서술과 AgentCore, Cognito, 멀티 어카운트 절 제거. 배포 형태를 §2로 교체. 3D 토폴로지 모듈 규칙 추가 |
| `README.md` | 아키텍처 그림과 기능 표에서 AgentCore, Cognito, ALB, 가이드 사이트 제거. 3D 토폴로지 항목 추가 |
| `.claude/settings.json` | 삭제한 훅과 스킬 참조 제거. `contextFiles`에서 `scripts/ARCHITECTURE.md` 유지 |
| `scripts/ARCHITECTURE.md` | AgentCore 절 삭제 |
| `scripts/09-start-all.sh`, `10-stop-all.sh`, `11-verify.sh`, `install-all.sh` | AgentCore, Cognito 분기 제거 |
| `src/app/page.tsx` | AgentCore 카드와 링크 제거 |
| `src/components/layout/Sidebar.tsx` | AI Assistant, AgentCore 메뉴 제거. 3D Topology 메뉴 추가 |
| `src/lib/app-config.ts` | `agentRuntimeArn`, `codeInterpreterName`, `memoryId` 필드 제거. `topology3d` 설정 블록과 `singleUser` 플래그 추가 |
| `src/lib/i18n/translations/{ko,en,zh}.json` | `agentcore.*`, `ai.*` 키 삭제, `topology3d.*` 키 추가 |
| `infra-cdk/lib/awsops-stack.ts` | §2 형태로 축소 |
| `.env.example` | `NEXT_PUBLIC_BASE_PATH` 제거 (이미 basePath 없음), `AWSOPS_SINGLE_USER` 추가 |
| `package.json` | `@aws-sdk/client-bedrock-agentcore` 제거. §6 의존성 추가. `name`을 `awsops`로 |

### 1.3 유지 (손대지 않음)

Steampipe pg 풀과 캐시, 대시보드 40페이지 중 위에서 지운 2개를 뺀 나머지, `ai-diagnosis`(Bedrock 직접 호출, DOCX/PDF 리포트), `powerpipe/` CIS 컴플라이언스, `datasources/`, K8s 페이지(빈 화면으로 남음), 멀티 어카운트 코드 경로(config에 계정 1개), `cache-warmer`, `.claude/hooks/secret-scan.sh`와 `pre-commit.sh`, `tests/`.

### 1.4 순서

훅이 삭제된 파일을 참조하면 이후 편집마다 오류가 난다. **`.claude/settings.json`과 훅 삭제를 가장 먼저** 하고, 그다음 디렉터리 삭제, 코드 수정, 마지막에 `npm run build`로 참조 누락을 잡는다. Phase 0은 커밋 하나로 묶는다.

---

## 2. 배포 형태

PLick 모니터링 EC2(`docs/monitoring.md`)와 같은 방식이다. ALB, ACM, Route 53, Cognito를 모두 쓰지 않는다.

```
노트북 ── SSM 포트 포워딩 (3000) ──► awsops EC2 (PLick prod VPC, 프라이빗 서브넷)
                                       ├─ Next.js :3000  (프로덕션 빌드, pm2 또는 systemd)
                                       ├─ Steampipe :9193 (내장 PG, aws 플러그인)
                                       └─ Powerpipe (CIS, 선택)
                                       인스턴스 롤 ─► AWS 읽기 전용 + Bedrock 호출
```

| 항목 | 값 |
|---|---|
| 인스턴스 | t4g.large (arm64, 8GB). Steampipe 내장 PG와 Next 빌드에 4GB는 부족 |
| AMI | Amazon Linux 2023 arm64 (기존 `01-install-base.sh` 전제) |
| 서브넷 | PLick prod VPC 프라이빗 서브넷. NAT 경유 아웃바운드만 |
| 보안그룹 | 인바운드 없음 |
| 접속 | `aws ssm start-session --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000` |
| IAM 롤 | `ReadOnlyAccess` + `AmazonSSMManagedInstanceCore` + 인라인 `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse`, `bedrock:ConverseStream` |
| 인증 | 없음. `auth-utils`는 ALB 헤더가 없으면 `anonymous`로 폴백하므로 그대로 동작 |
| 관리자 게이팅 | `AWSOPS_SINGLE_USER=true`면 `adminEmails` 검사를 통과시킨다. 인바운드가 없어서 안전하다는 전제를 코드 주석에 남긴다 |
| 미사용 시 | 인스턴스 정지. 데모 전 기동 |

CDK 스택은 EC2 + IAM 롤 + SG 세 리소스로 줄이고 VPC와 서브넷은 `-c vpcId -c subnetId`로 가져온다.
Bedrock 모델 접근은 콘솔에서 한 번 활성화해야 한다(계정 최초 1회).

---

## 3. 아키텍처

```
Steampipe rows ─┐
Fixture JSON ───┼─► 어댑터 ─► TopologyGraph ─► applyFilter(graph, filter) ─► layout3d ─► R3F Scene
Generator(seed)─┘                                    ▲                                    │
                                                      │                                    ▼
                          FilterPanel(체크박스) ──────┤                              Inspector / Labels
                          URL search params ─────────┤
                          Chat(자연어 → filter patch)┘
```

렌더러는 Steampipe를 모른다. `TopologyGraph`만 받는다. 필터는 순수 함수다. 채팅은 필터 패치를 만들 뿐 씬을 직접 건드리지 않는다.
기존 FossFLOW 생성기가 Steampipe 행을 직접 읽는 구조라, 이 계약을 사이에 끼우는 것이 첫 작업이다.

### 3.1 데이터 계약 `src/lib/topology/types.ts`

```ts
export type NodeKind =
  | 'ec2' | 'alb' | 'nlb' | 'nat' | 'igw' | 'tgw' | 'endpoint' | 'lambda'
  | 'rds' | 'elasticache' | 'msk' | 'opensearch' | 'eks'
  | 's3' | 'dynamodb' | 'cloudfront' | 'route53';

export type Tier = 'public' | 'private';

export interface TopologyGraph {
  meta: { source: 'live' | 'fixture' | 'generator'; accountId?: string; generatedAt: string; seed?: number };
  vpcs: { id: string; name: string; cidr: string }[];
  subnets: { id: string; vpcId: string; az: string; cidr: string; tier: Tier; name: string }[];
  nodes: { id: string; kind: NodeKind; name: string; vpcId?: string; subnetId?: string; az?: string; state?: string; meta: Record<string, unknown> }[];
  edges: { id: string; from: string; to: string; kind: 'target' | 'route' | 'attach' | 'egress'; label?: string }[];
}
```

퍼블릭/프라이빗 판정(라우트 테이블의 `igw-` 경로, 없으면 `map_public_ip_on_launch`)은 어댑터가 한다. 렌더러와 필터는 `tier`만 본다.

### 3.2 필터 `src/lib/topology/filter.ts`

```ts
export interface TopologyFilter {
  vpcId: string | null;                 // null = 첫 VPC
  tiers: Record<Tier, boolean>;
  kinds: Record<NodeKind, boolean>;
  azs: string[] | null;                 // null = 전체
  includeEmptySubnets: boolean;
  query: string;                        // 이름·ID 부분 일치
}
export const DEFAULT_FILTER: TopologyFilter;
export function applyFilter(g: TopologyGraph, f: TopologyFilter): TopologyGraph;   // 순수
export function mergeFilter(f: TopologyFilter, patch: Partial<TopologyFilter>): TopologyFilter;
export function filterToSearchParams(f: TopologyFilter): URLSearchParams;
export function filterFromSearchParams(p: URLSearchParams): TopologyFilter;
```

체크박스 패널, URL, 채팅 셋 다 `Partial<TopologyFilter>`를 만들어 `mergeFilter`에 넣는다. "퍼블릭 서브넷 빼고"는 `{ tiers: { public: false } }`, "람다 빼고"는 `{ kinds: { lambda: false } }`다.
노드를 지우면 그 노드에 걸린 엣지도 지운다. 서브넷이 비면 `includeEmptySubnets`가 false일 때 서브넷도 지운다.

### 3.3 어댑터 `src/lib/topology/adapters/`

| 파일 | 입력 | 비고 |
|---|---|---|
| `live.ts` | `relationships.ts` 쿼리 18종의 행 | 기존 `generator.ts` 160~260행의 분류 로직을 옮겨온다 |
| `fixture.ts` | JSON 파일 또는 업로드 | 스키마 검증(`validateGraph`) 후 반환. 실패 시 어떤 필드가 틀렸는지 메시지 |
| `generator.ts` | `GeneratorParams` | 결정적 PRNG(mulberry32). 같은 시드는 같은 그래프 |

```ts
export interface GeneratorParams {
  seed: number;
  vpcs: number;                 // 1~4
  azsPerVpc: number;            // 2~4
  subnetsPerAzPerTier: number;  // 1~4
  ec2PerSubnet: [number, number];   // 범위, 예 [10, 60]
  albsPerVpc: number;
  natPerAz: 0 | 1;
  lambdaPerVpc: number;
  rdsPerVpc: number;
  extras: Partial<Record<NodeKind, number>>;  // s3, dynamodb 등 전역 리소스
}
export const PRESETS: Record<'small' | 'medium' | 'large' | 'stress', GeneratorParams>;
```

`stress` 프리셋이 성공 기준(EC2 1,000, 서브넷 30)이다. 이름과 ID는 실제 형식(`i-0a1b…`, `subnet-…`, `Name` 태그 스타일)을 따라 라이브와 구분되지 않게 만든다.

### 3.4 내보내기와 익명화 `src/lib/topology/anonymize.ts`

라이브 그래프를 JSON으로 내려받는 버튼. `anonymize: true`면 계정 ID, 이름 태그, IP를 시드 기반 해시로 치환하고 ID 형식은 유지한다.
큰 계정 스냅샷을 픽스처로 저장해 두면 가장 좋은 회귀 데이터가 된다. 픽스처는 `src/lib/topology/fixtures/`에 두고 `plick-prod.json`(익명화)과 `stress-1000.json`(생성기 산출)을 기본 포함한다.

### 3.5 3D 레이아웃 `src/lib/topology/layout3d.ts`

순수 함수. 그래프를 받아 각 요소의 월드 좌표와 크기를 돌려준다. 렌더러는 좌표만 그린다.

| 요소 | 배치 |
|---|---|
| VPC | 바닥판. 여러 VPC는 X축으로 나란히 |
| AZ | VPC 안에서 X축 레인 |
| 티어 | Z축. 퍼블릭이 앞(카메라 쪽), 프라이빗이 뒤 |
| 서브넷 | 티어 레인 위의 단(platform). 크기는 내용물 수에 따라 |
| 노드 | 서브넷 단 위 격자. 종류별로 묶어 배치 |
| IGW, TGW | VPC 앞 가장자리 |
| ALB, NLB | 퍼블릭 티어 앞 띠(스킴이 internal이면 프라이빗 티어) |
| 전역 리소스 (S3, DynamoDB, CloudFront, Route53) | VPC 바깥 오른쪽 트레이 |
| 엣지 | 타겟 그룹(ALB→EC2), 라우트(서브넷→NAT/IGW), 어태치(TGW→VPC). 단일 `LineSegments` |

**클러스터링.** 한 서브넷에 같은 종류 노드가 `clusterThreshold`(기본 24)를 넘으면 스택 하나로 접고 `×N` 라벨을 단다. 클릭하면 그 서브넷만 펼친다(`expanded: Set<subnetId>`는 UI 상태, 필터가 아님). 펼친 서브넷의 단은 넓어진다.

### 3.6 렌더러 `src/components/topology3d/`

React Three Fiber v8 (React 18 호환 마지막 메이저). Next에서 `dynamic(() => import(...), { ssr: false })`로만 불러온다.

| 컴포넌트 | 역할 |
|---|---|
| `Scene.tsx` | Canvas, 조명, OrbitControls, fit-to-bounds, 리사이즈 |
| `Ground.tsx` | VPC 바닥판, AZ 레인, 티어 구분, 서브넷 단. 정적 메시 |
| `InstancedNodes.tsx` | 종류별 `InstancedMesh` 하나씩. 색은 상태(running, stopped)로 인스턴스 컬러. 호버와 선택은 `instanceId` 레이캐스트 |
| `Edges.tsx` | 모든 엣지를 하나의 `LineSegments`로. 선택 노드에 걸린 엣지만 밝게 |
| `Labels.tsx` | drei `Text`(troika SDF). VPC, AZ, 서브넷 라벨만 상시. 노드 라벨은 호버 시 하나. 보이는 노드 300개 초과면 서브넷 라벨도 카메라 거리로 컬링 |
| `Inspector.tsx` | 선택 노드의 메타 표시 (기존 DataTable 스타일). 상세 페이지 링크 |
| `FilterPanel.tsx` | 체크박스: 티어 2, 종류 17, AZ, 빈 서브넷, 검색어. VPC 셀렉트 |
| `SourcePanel.tsx` | Live / Fixture / Generator 탭. Generator는 프리셋 + 슬라이더 + 시드. Fixture는 파일 업로드와 내장 목록. 내보내기 버튼 |
| `ChatPanel.tsx` | 스트리밍 메시지, 필터 패치 적용 알림("퍼블릭 서브넷을 숨겼습니다"), 되돌리기 |
| `PerfHud.tsx` | fps, 드로우 콜, 보이는 노드 수. 개발 중과 포트폴리오 캡처용 |

성능 규칙: 노드는 반드시 인스턴싱, 라벨은 상한, 엣지는 단일 지오메트리, 필터 변경 시 씬을 새로 만들지 않고 인스턴스 행렬만 갱신, `useMemo`로 레이아웃 캐시, `frameloop="demand"`로 정지 시 렌더 중단.

### 3.7 페이지 `src/app/topology-3d/page.tsx`

레이아웃은 3열이다. 왼쪽 필터와 소스 패널(접힘 가능), 가운데 캔버스, 오른쪽 인스펙터와 채팅(탭). 상태는 페이지 컴포넌트가 들고 `useTopologyFilter`(URL 동기화)와 `useTopologySource`(소스와 그래프 로딩) 훅으로 나눈다.

Live 모드의 데이터 호출은 기존 `POST /api/steampipe`에 `relationships.ts` 쿼리를 그대로 보낸다. 새 API가 필요 없다.

### 3.8 채팅 API `src/app/api/topology3d-chat/route.ts`

기존 `topology-chat`과 달리 **모델 전체를 프롬프트에 넣지 않는다.** 필터 스키마, 현재 필터, 그래프 요약(VPC 목록, AZ 목록, 종류별 개수)만 보낸다. 프롬프트가 작아 빠르고 싸다.

- Bedrock `ConverseStream` + `toolConfig`로 구조화 출력. 도구 `set_filter(patch: Partial<TopologyFilter>)`와 `answer(text)` 둘. 정규식으로 JSON을 긁는 기존 방식은 쓰지 않는다.
- 응답 텍스트는 SSE로 스트리밍. 도구 호출은 스트림 종료 시 한 번에 클라이언트로 전달.
- 서버에서 패치를 `mergeFilter`로 검증(존재하지 않는 kind, AZ 거르기)한 뒤 내려보낸다.
- 모델 ID는 `config.topology3d.chatModelId`. 기본값은 리포가 쓰는 기존 상수. 필터 번역은 작은 모델로 충분하니 배포 후 저렴한 모델로 바꿀 수 있게 둔다.
- 대화 이력은 클라이언트가 최근 10턴만 보낸다. 서버 저장 없음.

예시. "퍼블릭 서브넷이랑 람다는 빼고 a존만 보여줘" → `set_filter({ tiers: { public: false }, kinds: { lambda: false }, azs: ['ap-northeast-2a'] })` + "퍼블릭 티어와 Lambda를 숨기고 2a만 남겼습니다."

---

## 4. 단계별 작업

| Phase | 내용 | 산출물 | 완료 기준 |
|---|---|---|---|
| 0 | 걷어내기 (§1) | 커밋 1개 | `npm run build` 통과, 사이드바에 죽은 링크 없음 |
| 1 | 계약과 Live 어댑터 | `types.ts`, `filter.ts`, `adapters/live.ts`, vitest 설정 | 기존 FossFLOW 뷰가 `TopologyGraph`를 거쳐도 동일하게 그려짐. 필터 순수 함수 테스트 |
| 2 | Fixture, Generator, 내보내기 | `adapters/fixture.ts`, `adapters/generator.ts`, `anonymize.ts`, `fixtures/`, `SourcePanel` | 시드 재현성 테스트. stress 프리셋 생성 100ms 이내 |
| 3 | 3D 렌더러 | `layout3d.ts`, `components/topology3d/*`, 페이지 | stress 프리셋에서 60fps, PerfHud 수치 기록 |
| 4 | 필터 패널, URL, 채팅 | `FilterPanel`, `useTopologyFilter`, `ChatPanel`, 채팅 API | 세 경로 모두 같은 결과. 채팅 응답 3초 이내 |
| 5 | 배포와 마감 | CDK 축소, 스크립트 정리, i18n, README, `docs/perf/` 측정표 | EC2에서 Live 모드로 PLick 계정 렌더. 스크린샷과 수치 기록 |

Phase 1과 2는 UI 없이 끝난다. Phase 3는 Generator 데이터로 만든다. Live 연결은 Phase 5에서 처음 확인한다.

브랜치는 `feature/topology-3d`. Phase마다 커밋을 나누고, Phase 0은 별도 커밋으로 두어 "걷어낸 것"과 "만든 것"이 이력에서 구분되게 한다. upstream으로 PR을 보내지 않는다.

---

## 5. 파일 목록

### 신규

```
src/lib/topology/types.ts
src/lib/topology/filter.ts
src/lib/topology/layout3d.ts
src/lib/topology/anonymize.ts
src/lib/topology/validate.ts
src/lib/topology/adapters/live.ts
src/lib/topology/adapters/fixture.ts
src/lib/topology/adapters/generator.ts
src/lib/topology/fixtures/plick-prod.json
src/lib/topology/fixtures/stress-1000.json
src/lib/topology/__tests__/filter.test.ts
src/lib/topology/__tests__/generator.test.ts
src/lib/topology/__tests__/layout3d.test.ts
src/lib/topology/CLAUDE.md
src/components/topology3d/{Scene,Ground,InstancedNodes,Edges,Labels,Inspector,FilterPanel,SourcePanel,ChatPanel,PerfHud}.tsx
src/hooks/useTopologyFilter.ts
src/hooks/useTopologySource.ts
src/app/topology-3d/page.tsx
src/app/api/topology3d-chat/route.ts
vitest.config.ts
docs/perf/topology-3d/README.md
docs/decisions/010-topology-graph-contract.md
docs/decisions/011-ssm-only-deployment.md
```

### 수정

§1.2 표 전체. 추가로 `next.config.mjs`에 `transpilePackages: ['three']`, `src/lib/fossflow/generator.ts`는 Phase 1에서 `TopologyGraph`를 입력으로 받도록 앞부분만 교체.

---

## 6. 의존성

| 패키지 | 버전 | 이유 |
|---|---|---|
| `three` | `^0.169` | 렌더링 |
| `@react-three/fiber` | `^8.17` | React 18 호환. v9는 React 19 필요 |
| `@react-three/drei` | `^9.114` | OrbitControls, Text, Bounds. v10은 fiber v9 필요 |
| `@types/three` | three와 동일 마이너 | 타입 |
| `vitest` | `^2` | 순수 함수 테스트. 리포에 TS 테스트 러너가 없음 |
| `@aws-sdk/client-bedrock-runtime` | 기존 | `ConverseStream` 사용 |

제거: `@aws-sdk/client-bedrock-agentcore`, `fossflow`는 기존 뷰가 남으므로 유지.

---

## 7. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 훅이 삭제 파일을 참조해 편집마다 실패 | Phase 0에서 `settings.json`을 가장 먼저 수정 |
| `InstancedMesh` 레이캐스트가 1,000개에서 느림 | BVH 없이도 인스턴스 1,000개는 문제없음. 5,000 이상이면 `three-mesh-bvh` 검토 |
| troika `Text`가 라벨 수백 개에서 병목 | 노드 라벨은 호버 1개만. 서브넷 라벨 상한과 거리 컬링 |
| Next 14 SSR에서 three가 `window` 참조 | 페이지 전체를 `dynamic(..., { ssr: false })`. `transpilePackages` 설정 |
| Bedrock 모델 접근 미활성 | 배포 전 콘솔에서 활성화. 채팅 실패 시 필터 패널은 독립 동작 |
| PLick 계정이 작아 Live 화면이 심심함 | 포트폴리오 캡처는 `stress`와 `plick-prod` 픽스처로. Live는 "실제 연동 증명"용 |
| `report-pdf`가 EC2에서 Chromium 필요 | 이 계획 범위 밖. 실패해도 DOCX 경로는 동작 |
| Steampipe 초기 캐시 채우기 2~3분 | `cache-warmer` 유지. 데모 전 기동 후 5분 대기 |

---

## 8. 확정 필요 사항

기본값을 정해 두었다. 다르게 가려면 Phase 시작 전에 바꾼다.

1. **AI 어시스턴트 페이지 삭제** (기본: 삭제). 남기려면 `aws-data`와 `general` 두 라우트만 추려 약 300줄로 재작성해야 한다.
2. **CDK 유지** (기본: EC2 + 롤 + SG로 축소 유지). PLick 모니터링처럼 콘솔 절차서로 갈 수도 있다.
3. **채팅 모델** (기본: 리포 기존 상수). 배포 후 비용을 보고 교체.
4. **클러스터 임계값** (기본: 24). 실제 화면을 보고 조정.
5. **기존 Topology View와 2D 탭 유지** (기본: 유지). 3D가 안정되면 사이드바에서 내릴지 결정.
