# 3D 토폴로지 컴포넌트 (`src/components/topology3d/`)

## 역할
3D 토폴로지 뷰의 UI. 렌더러는 `Layout3D`(`@/lib/topology/layout3d`)만 받고 좌표를 계산하지 않으며 Steampipe를 모른다. 상태는 페이지(`src/app/topology-3d/page.tsx`)와 훅(`@/hooks/useTopologySource`, `@/hooks/useTopologyFilter`)이 들고, 컴포넌트는 받은 것을 그리고 콜백만 호출한다. ADR-012 참조.

```
page: graph ─ applyFilter ─ computeLayout(useMemo) ─► Layout3D ─► Scene(Canvas)
                                                          ├─ Ground          바닥 4세트 (InstancedMesh ×4)
                                                          ├─ InstancedNodes  종류별 InstancedMesh + 선택 강조 1
                                                          ├─ Edges           LineSegments 1
                                                          ├─ Labels          troika Text (상한 96, 거리 컬링) + 호버 빌보드 1
                                                          └─ PerfProbe ─► perfStore ◄─ PerfHud (HTML 오버레이)
      selection / expanded ◄──── Inspector (HTML) ────────────────────────────────┘
      filter (useTopologyFilter ↔ URL) ◄── FilterPanel (HTML) · ChatPanel (HTML, SSE ◄─ /api/topology3d-chat)
```

## 파일
| 파일 | 역할 | three |
|---|---|---|
| `Scene.tsx` | Canvas 진입점. 조명, `OrbitControls`(damping 없음), `FitCamera`(`fitKey`가 바뀔 때만 카메라 맞춤), 커서, 네 레이어 조립, HUD 오버레이. **호버는 여기 로컬 상태** — 페이지는 포인터 이동에 리렌더하지 않는다 | O |
| `Ground.tsx` | VPC 바닥판·트레이, AZ 레인, 티어 띠, 서브넷 단. 세트마다 `InstancedMesh` 하나. 서브넷 단 클릭 → 선택 + (펼칠 수 있으면) 펼침 토글 | O |
| `InstancedNodes.tsx` | `NodeKind`별 `InstancedMesh`. 스택은 같은 지오메트리를 Y로 늘임. 행렬은 레이아웃이 바뀔 때, 색은 호버·선택이 바뀔 때만 다시 쓴다. `toNodeItems(layout)`가 노드+스택 목록 | O |
| `Edges.tsx` | 모든 엣지를 `LineSegments` 하나로 (엣지당 `from→mid→to` 2선분). 정점 색으로 종류 표시, 선택과 닿은 엣지만 밝게 | O |
| `Labels.tsx` | VPC·AZ·트레이 라벨 상시, 서브넷·스택 라벨은 상한(`LABEL_CAP`=96)과 거리 컬링(노드 300개 초과 시 55 유닛). 호버 라벨은 `Billboard` 1개. 컬링은 `useFrame`에서 `visible`만 토글 (React 상태 없음) | O |
| `PerfHud.tsx` | `PerfProbe`(named, 캔버스 안): 매 프레임 fps·드로우 콜·삼각형을 `perfStore`에 기록, 루프가 멈춘 뒤 trailing 발행. 벤치마크는 `frameloop`을 `always`로 바꾸고 5초 자동 회전. 기본 내보내기는 HTML 오버레이 | O |
| `Inspector.tsx` | 선택 상세: 노드(메타·연결·상세 페이지 링크) / 스택(멤버 목록) / 서브넷(종류별 개수, 펼침 버튼) / VPC. **three 미사용** — 페이지가 정적으로 import | X |
| `SourcePanel.tsx` | Live / Fixture / Generator 전환, 프리셋·시드·슬라이더, 업로드, 내보내기 | X |
| `palette.ts` | 종류별 형태(`KIND_SHAPES`)와 지오메트리(`makeGeometry`), 상태·호버·선택 색 규칙(`nodeColor`). `colors.ts`를 재내보냄 | O |
| `colors.ts` | 종류·엣지·바닥·라벨 색 상수, `isInactiveState`. **three 미사용** | X |
| `perfStore.ts` | 프로브와 HUD가 공유하는 외부 스토어 (`useSyncExternalStore`) | X |
| `FilterPanel.tsx` | 티어·빈 서브넷·AZ·종류(VPC/전역) 체크박스, 검색(200ms 디바운스), 초기화, 링크 복사. 개수는 필터 전 그래프에서 센다. 패치만 낸다 | X |
| `ChatPanel.tsx` | 자연어 → `/api/topology3d-chat`(SSE). 최근 10턴 + 현재 필터 + `summarizeGraph`를 보내고 텍스트를 스트리밍, `filter` 이벤트의 패치를 `onPatch`로 적용. 메시지마다 적용 전 필터를 기억해 되돌리기, `diffFilter` 칩, `rejected` 표시. 중지(AbortController), 제안 칩 | X |

## 규칙
- 모든 파일 `'use client'`. `export default` 컴포넌트 (`PerfProbe`, `toNodeItems`처럼 보조는 named)
- three/R3F를 import하는 파일(표의 O)은 `Scene.tsx`를 통해서만 페이지에 닿는다. 페이지는 `dynamic(() => import('@/components/topology3d/Scene'), { ssr: false })`. HTML 패널(`Inspector`, `SourcePanel`)은 `colors.ts`만 쓰고 `palette.ts`를 import하지 않는다
- **컴포넌트는 상태를 소유하지 않는다.** 필터는 `useTopologyFilter`(URL 동기화), 소스는 `useTopologySource`, 선택·펼침은 페이지, 호버만 `Scene` 로컬. `FilterPanel`·`ChatPanel`·툴바는 `TopologyFilterPatch`를 `onPatch`로 낼 뿐 필터를 직접 바꾸지 않는다 (ADR-013)
- 좌표를 계산하지 않는다. 위치·크기·라벨·엣지 끝점은 `Layout3D`에서 온다. 배치를 바꾸려면 `src/lib/topology/layout3d.ts`
- 성능: 노드는 종류별 `InstancedMesh`, 엣지는 단일 `LineSegments`, 라벨 상한, `frameloop="demand"`. 필터가 바뀌어도 씬을 새로 만들지 않고 인스턴스 행렬·색만 갱신한다. `InstancedMesh`는 인스턴스 수가 바뀔 때만 `key`로 재생성
- 매 프레임 도는 코드(`useFrame`)에서 React 상태를 바꾸지 않는다. 수치는 `perfStore`, 가시성은 `visible` 직접 토글
- 문구는 `useLanguage()`의 `t('topology3d.*')`. 새 문구는 ko/en/zh 세 파일 모두에 넣는다
- Tailwind 색은 테마 토큰만 (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`). 3D 재질 색은 `colors.ts`에만
- troika `Text`는 기본 폰트를 CDN(jsdelivr)에서 받는다. 브라우저에 인터넷이 없으면 라벨이 비어 보인다 (씬은 정상)

---

# 3D Topology Components (English)

## Role
UI for the 3D topology view. The renderer consumes `Layout3D` (`@/lib/topology/layout3d`), computes no positions and never sees Steampipe. State lives in the page (`src/app/topology-3d/page.tsx`) and its hooks (`@/hooks/useTopologySource`, `@/hooks/useTopologyFilter`); components draw what they are handed and call back. See ADR-012.

## Files
| File | Role | three |
|---|---|---|
| `Scene.tsx` | Canvas entry. Lights, `OrbitControls` (no damping), `FitCamera` (refits only when `fitKey` changes), cursor, the four layers, HUD overlay. **Hover is local state here** so the page never re-renders on pointer move | yes |
| `Ground.tsx` | VPC plates + tray, AZ lanes, tier bands, subnet platforms; one `InstancedMesh` per set. Clicking a platform selects it and toggles expansion when it has stacks | yes |
| `InstancedNodes.tsx` | One `InstancedMesh` per `NodeKind`; a stack is the same geometry stretched on Y. Matrices are rewritten on layout change only, colours on hover / selection. `toNodeItems(layout)` lists nodes + stacks | yes |
| `Edges.tsx` | Every edge in one `LineSegments` (`from→mid→to`, two segments each). Vertex colours carry the kind; only edges touching the selection are lit | yes |
| `Labels.tsx` | VPC / AZ / tray labels always; subnet and stack labels under `LABEL_CAP` (96) and distance-culled (55 units) above 300 nodes. One `Billboard` hover label. Culling toggles `visible` inside `useFrame`, no React state | yes |
| `PerfHud.tsx` | `PerfProbe` (named, inside the Canvas) writes fps / draw calls / triangles per frame into `perfStore` and publishes once more after the loop goes quiet. The benchmark sets `frameloop` to `always` and auto-rotates for 5s. Default export is the HTML overlay | yes |
| `Inspector.tsx` | Selection details: node (meta, connections, detail-page link) / stack (members) / subnet (counts by kind, expand button) / VPC. **No three.js** — imported statically by the page | no |
| `SourcePanel.tsx` | Live / Fixture / Generator switch, presets, seed, sliders, upload, export | no |
| `palette.ts` | Shapes per kind (`KIND_SHAPES`), geometry (`makeGeometry`), state / hover / selection colour rule (`nodeColor`). Re-exports `colors.ts` | yes |
| `colors.ts` | Kind / edge / ground / label colours, `isInactiveState`. **No three.js** | no |
| `perfStore.ts` | External store shared by probe and HUD (`useSyncExternalStore`) | no |
| `FilterPanel.tsx` | Tier / empty-subnet / AZ / kind (VPC vs global) checkboxes, search (200ms debounce), reset, copy link. Counts come from the unfiltered graph. Emits patches only | no |
| `ChatPanel.tsx` | Natural language → `/api/topology3d-chat` (SSE). Sends the last 10 turns + current filter + `summarizeGraph`, streams text, applies the `filter` event's patch through `onPatch`. Each message remembers the filter before it for undo, shows `diffFilter` chips and `rejected` items. Stop (AbortController), suggestion chips | no |

## Rules
- Every file is `'use client'` with a `export default` component (helpers such as `PerfProbe`, `toNodeItems` are named exports)
- Files that import three/R3F (marked yes) reach the page only through `Scene.tsx`, loaded as `dynamic(() => import('@/components/topology3d/Scene'), { ssr: false })`. HTML panels (`Inspector`, `SourcePanel`) use `colors.ts` and never import `palette.ts`
- **Components own no state.** The filter belongs to `useTopologyFilter` (URL-synced), the source to `useTopologySource`, selection and expansion to the page; only hover is `Scene`-local. `FilterPanel`, `ChatPanel` and the toolbar emit a `TopologyFilterPatch` through `onPatch` and never mutate the filter (ADR-013)
- Never compute positions here; position, size, labels and edge endpoints come from `Layout3D`. Change placement in `src/lib/topology/layout3d.ts`
- Performance: one `InstancedMesh` per kind, one `LineSegments` for all edges, a label cap, `frameloop="demand"`. A filter change updates instance matrices and colours instead of rebuilding the scene; an `InstancedMesh` is re-created (via `key`) only when its instance count changes
- Never set React state from per-frame code (`useFrame`): numbers go to `perfStore`, visibility is toggled on `visible` directly
- Copy comes from `t('topology3d.*')` via `useLanguage()`; add every new key to all three of ko/en/zh
- Tailwind colours are theme tokens only (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`); 3D material colours live only in `colors.ts`
- troika `Text` fetches its default font from a CDN (jsdelivr). Without internet in the browser the labels render empty; the scene itself is unaffected
