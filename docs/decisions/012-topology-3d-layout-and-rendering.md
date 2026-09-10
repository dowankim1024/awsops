# ADR-012: 3D 토폴로지 레이아웃과 렌더링 전략

- 상태: 채택 (2026-09-10, Phase 3)
- 관련: ADR-010 (TopologyGraph 계약), `docs/plans/2026-09-09-topology-3d-and-slimdown.md` §3.5–3.6

## 맥락

수백~수천 노드를 브라우저에서 60fps로 그리면서, 필터(체크박스·URL·채팅)가 바뀔 때마다 씬을 새로 만들지 않아야 한다.
렌더러가 Steampipe나 데이터 소스를 알면 소스가 늘 때마다 렌더러가 바뀌므로, 렌더러의 입력을 `TopologyGraph`보다 한 단계 더 좁혀야 했다.

## 결정

1. **레이아웃은 순수 함수다.** `computeLayout(graph, { clusterThreshold, expanded })`(`src/lib/topology/layout3d.ts`)가 모든 요소의 월드 좌표·크기·라벨·엣지 끝점·바운드를 돌려준다. 렌더러(`src/components/topology3d/`)는 `Layout3D`만 받고 좌표를 계산하지 않는다. 결정적이므로 vitest로 겹침·포함·성능(stress 100ms 이내)을 검증한다.
2. **클러스터링은 레이아웃 책임이다.** 한 서브넷에 같은 종류 노드가 임계값(기본 24)을 넘으면 스택 하나로 접는다. 멤버의 앵커는 스택 꼭대기를 가리켜 엣지가 자동으로 스택에 모이고, 같은 앵커 쌍의 엣지는 하나로 접힌다(`sourceIds`에 원본 보존). 펼침(`expanded`)은 UI 상태이며 필터가 아니다 — URL과 채팅은 펼침을 모른다.
3. **VPC 배치.** VPC는 X축으로 나란히, AZ는 VPC 안 X축 레인, 티어는 Z축(퍼블릭이 카메라 쪽). 서브넷이 없는 VPC 노드는 세 서비스 행에 둔다: 앞(igw, tgw, internet-facing LB), 중간(internal LB, endpoint, eks, 그 외), 뒤(rds, elasticache, msk, opensearch). 계정 전역 노드는 오른쪽 트레이.
4. **드로우 콜을 종류 수에 묶는다.** 노드는 `NodeKind`별 `InstancedMesh` 하나(스택은 같은 지오메트리를 Y로 늘임), 바닥 4세트도 각각 `InstancedMesh`, 엣지는 단일 `LineSegments`(엣지당 2선분, 중간점을 띄워 단 위로 지나감), 선택 강조 1개. 라벨은 troika `Text`가 라벨당 메시 하나라 상한(96)과 거리 컬링(노드 300개 초과 시)으로 묶는다. troika `BatchedText`는 실험적이고 타입이 없어 이번에는 쓰지 않는다.
5. **정지 시 렌더 중단.** `frameloop="demand"`. 호버는 씬 내부 상태(페이지 리렌더 없음), 선택은 페이지 상태. 성능 수치는 캔버스 안 프로브가 외부 스토어에 쓰고 HTML HUD가 몇 Hz로 읽는다. 벤치마크는 5초간 `always`로 바꿔 카메라를 돌리며 평균·최저 fps와 p95 프레임 시간을 잰다.

## 결과

- 필터 변경 = `applyFilter` → `computeLayout` → 인스턴스 행렬·색 갱신. 씬 그래프 재구성 없음
- stress 프리셋(EC2 1,001) 첫 VPC: 개별 노드 55 + 스택 8, 드로우 콜 46, 삼각형 약 3,900, 레이아웃 1ms, 5초 벤치마크 평균 60fps·최저 56.5·p95 17.3ms (M5 Pro, Chrome 152; `docs/perf/topology-3d/README.md`)
- 라벨이 드로우 콜의 절반 이상을 차지한다. 라벨 수를 늘리려면 `BatchedText`나 스프라이트 아틀라스로 가야 한다
- 새 데이터 소스는 어댑터 하나만 추가하면 되고, 새 종류(NodeKind)는 `palette.ts`에 색·형태 한 줄씩이면 된다

---

# ADR-012: 3D Topology Layout and Rendering Strategy (English)

- Status: accepted (2026-09-10, Phase 3)
- Related: ADR-010 (TopologyGraph contract), `docs/plans/2026-09-09-topology-3d-and-slimdown.md` §3.5–3.6

## Context

Hundreds to thousands of nodes must render at 60fps in the browser, and a filter change (checkboxes, URL, chat) must not rebuild the scene. A renderer that knew about Steampipe or data sources would change with every new source, so its input had to be narrower than `TopologyGraph`.

## Decision

1. **Layout is a pure function.** `computeLayout(graph, { clusterThreshold, expanded })` (`src/lib/topology/layout3d.ts`) returns world position and size for every element plus labels, edge endpoints and bounds. The renderer (`src/components/topology3d/`) consumes `Layout3D` only and computes no positions. Being deterministic, it is covered by vitest for overlap, containment and speed (stress preset under 100ms).
2. **Clustering belongs to the layout.** More than `clusterThreshold` (default 24) same-kind nodes in a subnet fold into one stack. Members anchor to the stack top, so edges converge on the stack automatically and edges sharing an anchor pair fold into one (`sourceIds` keeps the originals). `expanded` is UI state, not filter state — URL and chat never see it.
3. **VPC placement.** VPCs side by side on X, AZs as X lanes inside a VPC, tiers on Z (public toward the camera). Subnet-less VPC nodes go to three service rows: front (igw, tgw, internet-facing LBs), middle (internal LBs, endpoints, eks, everything else), back (rds, elasticache, msk, opensearch). Account-global nodes sit in a tray on the right.
4. **Draw calls are bounded by kind count.** One `InstancedMesh` per `NodeKind` (a stack is the same geometry stretched on Y), four instanced ground sets, one `LineSegments` for all edges (two segments each with a lifted midpoint so lines arc over platforms), one highlight mesh. troika `Text` is one mesh per label, so labels are capped (96) and distance-culled above 300 nodes. troika `BatchedText` is experimental and untyped, so it is not used yet.
5. **No rendering while idle.** `frameloop="demand"`. Hover is scene-local state (no page re-render); selection is page state. Perf numbers flow from an in-canvas probe into an external store read by an HTML HUD at a few Hz. The benchmark switches to `always` for five seconds, auto-rotates the camera and records average / minimum fps and p95 frame time.

## Consequences

- A filter change is `applyFilter` → `computeLayout` → instance matrix / colour update; the scene graph is never rebuilt
- Stress preset (1,001 EC2), first VPC: 55 individual nodes + 8 stacks, 46 draw calls, ~3,900 triangles, layout 1ms, 5s benchmark avg 60fps / min 56.5 / p95 17.3ms (M5 Pro, Chrome 152; `docs/perf/topology-3d/README.md`)
- Labels are more than half of the draw calls; raising the label budget means `BatchedText` or a sprite atlas
- A new data source is one adapter; a new `NodeKind` is one colour and one shape line in `palette.ts`
