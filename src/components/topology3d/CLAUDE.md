# 3D 토폴로지 컴포넌트 (`src/components/topology3d/`)

## 역할
3D 토폴로지 뷰의 UI. 렌더러는 `Layout3D`(`@/lib/topology/layout3d`)만 받고 좌표를 계산하지 않으며 Steampipe를 모른다. 상태는 페이지(`src/app/topology-3d/page.tsx`)와 훅(`@/hooks/useTopologySource`, `@/hooks/useTopologyFilter`)이 들고, 컴포넌트는 받은 것을 그리고 콜백만 호출한다. ADR-012 참조.

```
page: graph ─ applyFilter ─ computeLayout(useMemo) ─► Layout3D ─► Scene(Canvas)
                                                          ├─ Ground          바닥 4세트 (InstancedMesh ×4)
                                                          ├─ InstancedNodes  종류별 아이콘 판 InstancedMesh(+스택 기둥) + 선택 강조 1
                                                          ├─ Edges           튜브 메시 1 (베지어, 흐름 셰이더)
                                                          ├─ Labels          troika Text (상한 96, 거리 컬링) + 호버 빌보드 1
                                                          ├─ PerfProbe ─► perfStore ◄─ PerfHud (HTML 오버레이)
                                                          └─ Legend (HTML 오버레이: 종류 아이콘·개수, 엣지 종류)
      selection / expanded ◄──── Inspector (HTML) ────────────────────────────────┘
      filter (useTopologyFilter ↔ URL) ◄── FilterPanel (HTML) · ChatPanel (HTML, SSE ◄─ /api/topology3d-chat)
```

## 파일
| 파일 | 역할 | three |
|---|---|---|
| `Scene.tsx` | Canvas 진입점. 선택에 닿는 엣지 인덱스(`highlight`)를 `layout.edgeIndexByElement`에서 뽑아 `Edges`에 넘긴다. 조명, `OrbitControls`(damping 없음), `FitCamera`(`fitKey`가 바뀔 때만 카메라 맞춤; 방향 (0.25, 0.75, 1)이 아이콘 판의 기울기 기준), 커서, 네 레이어 조립, HUD·범례 오버레이. `flow`면 `frameloop="always"`, 아니면 `demand`. **호버는 여기 로컬 상태** — 페이지는 포인터 이동에 리렌더하지 않는다 | O |
| `Ground.tsx` | VPC 바닥판·트레이(`layout.trays[]` 앞·뒤·옆), AZ 레인, 티어 띠, 서브넷 단. 세트마다 `InstancedMesh` 하나. 서브넷 단 클릭 → 선택 + (펼칠 수 있으면) 펼침 토글 | O |
| `InstancedNodes.tsx` | `NodeKind`별 아이콘 판(`makePlaqueGeometry`) `InstancedMesh` 하나, 스택이 있으면 기둥(`makeColumnGeometry`, 윗면 아이콘, Y 스케일) `InstancedMesh` 하나 더. 종류당 텍스처·재질 하나(`useKindAssets`, 아이콘 이미지는 로드되는 대로 그려 넣음). 인스턴스 색은 텍스처에 곱한다(`nodeTint`). 행렬은 레이아웃이 바뀔 때, 색은 호버·선택이 바뀔 때만 다시 쓴다. `toNodeItems(layout)`가 노드+스택 목록 | O |
| `Edges.tsx` | 모든 엣지를 튜브 메시 하나로 (`tubes.ts`: 엣지당 `from→mid→to` 2차 베지어를 링으로 샘플링, 반지름 0.04). 정점 색으로 종류 표시, 선택과 닿은 엣지(`highlight`, `layout.edgeIndexByElement`에서 온 인덱스 집합)만 밝게. `focus`면 나머지를 어둡게 하는 대신 지오메트리에서 빼 버린다 — 꺼져 있으면 `shown === edges`라 선택이 바뀌어도 튜브를 다시 만들지 않는다. `MeshBasicMaterial`에 `onBeforeCompile`로 음영·흐름 대시(`aT`·`aDir`, `uTime`·`uFlow`)와 **추론 엣지 점선**(`aDash`·`aDerived`, 곡선 길이 기준 `discard`)을 얹는다. `flow`가 켜지면 `useFrame`에서 시간만 갱신 | O |
| `tubes.ts` | `buildTubes(edges, opts)` → position/normal/t/dir/dash/derived/index typed array. `dash`는 곡선 길이 ÷ `DASH_WORLD`라 어디서나 대시 크기가 같다. **three 미사용**, vitest(`__tests__/tubes.test.ts`) | X |
| `Legend.tsx` | 범례 오버레이: 화면에 있는 종류(아이콘·이름·개수), 스택 설명, 엣지 종류를 "명시 관계 / 설정 추론" 두 묶음으로. 추론 묶음에는 점선 견본과 "허용된 경로이며 실제 트래픽이 아님" 한 줄. **three 미사용** | X |
| `icons.ts` | `KIND_ICON_URL`(종류→FossFLOW 내장 아이소메트릭 아이콘 data URI), `KIND_LABELS`. **three 미사용** — Legend·FilterPanel·palette가 공유 | X |
| `Labels.tsx` | VPC·AZ·트레이 라벨 상시, 서브넷·스택 라벨은 상한(`LABEL_CAP`=96)과 거리 컬링(노드 300개 초과 시 55 유닛). 호버 라벨은 `Billboard` 1개. 컬링은 `useFrame`에서 `visible`만 토글 (React 상태 없음) | O |
| `PerfHud.tsx` | `PerfProbe`(named, 캔버스 안): 매 프레임 fps·드로우 콜·삼각형을 `perfStore`에 기록, 루프가 멈춘 뒤 trailing 발행. 벤치마크는 `frameloop`을 `always`로 바꾸고 5초 자동 회전. 기본 내보내기는 HTML 오버레이 | O |
| `Inspector.tsx` | 선택 상세: 노드(메타·연결 20개·상세 페이지 링크) / 스택(멤버 목록) / 서브넷(종류별 개수, 펼침 버튼) / VPC. 연결 목록은 엣지 종류 배지(추론이면 점선 테두리)와 포트·IAM 액션을 함께 보인다. **three 미사용** — 페이지가 정적으로 import | X |
| `SourcePanel.tsx` | Live / Fixture / Generator 전환, 프리셋·시드·슬라이더, 업로드, 내보내기 | X |
| `palette.ts` | `ICON_TILT`(기본 카메라 고도각), `makePlaqueGeometry`(앞면만 아이콘 UV, 나머지 면은 배경 텍셀 하나로 UV 접기, 기울인 뒤 바닥을 -size/2에), `makeColumnGeometry`(윗면 아이콘), `createKindTexture`(128px 캔버스: 종류색 배경 + 테두리 + 아이콘), `loadKindIcon`(이미지 캐시), `nodeTint`(흰색/비활성 0.38/호버 1.5/선택 시안). `colors.ts`를 재내보냄 | O |
| `colors.ts` | 종류·엣지·바닥·라벨 색 상수, `isInactiveState`. **three 미사용** | X |
| `perfStore.ts` | 프로브와 HUD가 공유하는 외부 스토어 (`useSyncExternalStore`) | X |
| `FilterPanel.tsx` | 티어·빈 서브넷·AZ·종류(VPC/전역)·엣지 종류(명시 4 + 추론 5) 체크박스, `showConnectedGlobals` 토글, 검색(200ms 디바운스), 초기화, 링크 복사. 개수는 필터 전 그래프에서 센다. 패치만 낸다 | X |
| `ChatPanel.tsx` | 자연어 → `/api/topology3d-chat`(SSE). 최근 10턴 + 현재 필터 + `summarizeGraph`를 보내고 텍스트를 스트리밍, `filter` 이벤트의 패치를 `onPatch`로 적용. 메시지마다 적용 전 필터를 기억해 되돌리기, `diffFilter` 칩, `rejected` 표시. 중지(AbortController), 제안 칩 | X |

## 규칙
- 모든 파일 `'use client'`. `export default` 컴포넌트 (`PerfProbe`, `toNodeItems`처럼 보조는 named)
- three/R3F를 import하는 파일(표의 O)은 `Scene.tsx`를 통해서만 페이지에 닿는다. 페이지는 `dynamic(() => import('@/components/topology3d/Scene'), { ssr: false })`. HTML 패널(`Inspector`, `SourcePanel`)은 `colors.ts`만 쓰고 `palette.ts`를 import하지 않는다
- **컴포넌트는 상태를 소유하지 않는다.** 필터는 `useTopologyFilter`(URL 동기화), 소스는 `useTopologySource`, 선택·펼침은 페이지, 호버만 `Scene` 로컬. `FilterPanel`·`ChatPanel`·툴바는 `TopologyFilterPatch`를 `onPatch`로 낼 뿐 필터를 직접 바꾸지 않는다 (ADR-013)
- 좌표를 계산하지 않는다. 위치·크기·라벨·엣지 끝점은 `Layout3D`에서 온다. 배치를 바꾸려면 `src/lib/topology/layout3d.ts`
- 성능: 노드는 종류별 `InstancedMesh`(노드 판 + 스택 기둥, 최대 2), 엣지는 단일 튜브 메시, 라벨 상한, `frameloop="demand"`(흐름 애니메이션 중에만 `always`). 필터가 바뀌어도 씬을 새로 만들지 않고 인스턴스 행렬·색만 갱신한다(엣지 튜브 지오메트리는 레이아웃마다 다시 만든다). `InstancedMesh`는 인스턴스 수가 바뀔 때만 `key`로 재생성
- 아이콘은 `src/lib/fossflow/icons.ts`의 내장 data URI만 쓴다(네트워크 없음). 새 종류는 `icons.ts`의 `KIND_ICON_ID`와 `KIND_LABELS`에 한 줄씩
- 노드 판은 기본 카메라 방향(`FitCamera`)을 향해 기울어 있다. 카메라 기본 방향을 바꾸면 `palette.ICON_TILT`도 맞춘다
- 매 프레임 도는 코드(`useFrame`)에서 React 상태를 바꾸지 않는다. 수치는 `perfStore`, 가시성은 `visible` 직접 토글
- 문구는 `useLanguage()`의 `t('topology3d.*')`. 새 문구는 ko/en/zh 세 파일 모두에 넣는다
- 툴바 **"연결선만"**(`focusEdges`)은 페이지 상태다. `Scene`이 `layout.edgeIndexByElement`로 선택에 닿는 인덱스를 풀고 `Edges`가 지오메트리를 좁힌다. 선택이 없으면 아무 효과가 없다 — 선택을 강제하지 않는다
- **명시 관계와 설정 추론은 화면에서 구분한다**(ADR-014): 추론 엣지는 점선, 범례·필터 패널은 두 묶음, 인스펙터 배지는 점선 테두리. "허용된 경로이며 실제 트래픽이 아님" 문구를 빼지 않는다
- Tailwind 색은 테마 토큰만 (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`). 3D 재질 색은 `colors.ts`에만
- troika `Text`는 기본 폰트를 CDN(jsdelivr)에서 받는다. 브라우저에 인터넷이 없으면 라벨이 비어 보인다 (씬은 정상)

---

# 3D Topology Components (English)

## Role
UI for the 3D topology view. The renderer consumes `Layout3D` (`@/lib/topology/layout3d`), computes no positions and never sees Steampipe. State lives in the page (`src/app/topology-3d/page.tsx`) and its hooks (`@/hooks/useTopologySource`, `@/hooks/useTopologyFilter`); components draw what they are handed and call back. See ADR-012.

## Files
| File | Role | three |
|---|---|---|
| `Scene.tsx` | Canvas entry. Resolves the selection's edge indices (`highlight`) from `layout.edgeIndexByElement` and hands them to `Edges`. Lights, `OrbitControls` (no damping), `FitCamera` (refits only when `fitKey` changes; its direction (0.25, 0.75, 1) is what the icon plaques tilt toward), cursor, the four layers, HUD and legend overlays. `frameloop="always"` while `flow` is on, else `demand`. **Hover is local state here** so the page never re-renders on pointer move | yes |
| `Ground.tsx` | VPC plates + trays (`layout.trays[]`: front, back, side), AZ lanes, tier bands, subnet platforms; one `InstancedMesh` per set. Clicking a platform selects it and toggles expansion when it has stacks | yes |
| `InstancedNodes.tsx` | Per `NodeKind`: one `InstancedMesh` of icon plaques (`makePlaqueGeometry`) and, when the kind has stacks, one of columns (`makeColumnGeometry`, icon on top, Y-scaled). One texture + material per kind (`useKindAssets`; icons are drawn in as their images load). Instance colour multiplies the texture (`nodeTint`). Matrices are rewritten on layout change only, colours on hover / selection. `toNodeItems(layout)` lists nodes + stacks | yes |
| `Edges.tsx` | Every edge in one tube mesh (`tubes.ts`: quadratic Bézier `from→mid→to` sampled into rings, radius 0.04). Vertex colours carry the kind; only edges touching the selection (`highlight`, a set of indices from `layout.edgeIndexByElement`) are lit. With `focus` on, the rest are left out of the geometry instead of dimmed — with it off `shown === edges`, so a selection change never rebuilds the tubes. A `MeshBasicMaterial` patched via `onBeforeCompile` adds shading, the flow dashes (`aT` / `aDir`, `uTime` / `uFlow`) and the **dashed pattern for inferred edges** (`aDash` / `aDerived`, `discard` by arc length). With `flow` on, `useFrame` only advances the time | yes |
| `tubes.ts` | `buildTubes(edges, opts)` → position / normal / t / dir / dash / derived / index typed arrays. `dash` is arc length ÷ `DASH_WORLD`, so dashes are the same size on every edge. **No three.js**, vitest (`__tests__/tubes.test.ts`) | no |
| `Legend.tsx` | Legend overlay: kinds on screen (icon, name, count), the stack convention, and edge kinds split into "explicit relationships" and "inferred from configuration" — the inferred group gets dashed swatches and the line "dashed lines are permitted paths, not observed traffic". **No three.js** | no |
| `icons.ts` | `KIND_ICON_URL` (kind → FossFLOW's embedded isometric icon data URI), `KIND_LABELS`. **No three.js** — shared by Legend, FilterPanel and palette | no |
| `Labels.tsx` | VPC / AZ / tray labels always; subnet and stack labels under `LABEL_CAP` (96) and distance-culled (55 units) above 300 nodes. One `Billboard` hover label. Culling toggles `visible` inside `useFrame`, no React state | yes |
| `PerfHud.tsx` | `PerfProbe` (named, inside the Canvas) writes fps / draw calls / triangles per frame into `perfStore` and publishes once more after the loop goes quiet. The benchmark sets `frameloop` to `always` and auto-rotates for 5s. Default export is the HTML overlay | yes |
| `Inspector.tsx` | Selection details: node (meta, 20 connections, detail-page link) / stack (members) / subnet (counts by kind, expand button) / VPC. The connection list shows an edge-kind badge (dashed border when inferred) plus ports and IAM actions. **No three.js** — imported statically by the page | no |
| `SourcePanel.tsx` | Live / Fixture / Generator switch, presets, seed, sliders, upload, export | no |
| `palette.ts` | `ICON_TILT` (elevation of the default camera), `makePlaqueGeometry` (icon UVs on the front face only, every other face collapsed to one background texel, tilted, then rested at -size/2), `makeColumnGeometry` (icon on top), `createKindTexture` (128px canvas: kind-colour background + border + icon), `loadKindIcon` (image cache), `nodeTint` (white / inactive 0.38 / hover 1.5 / selected cyan). Re-exports `colors.ts` | yes |
| `colors.ts` | Kind / edge / ground / label colours, `isInactiveState`. **No three.js** | no |
| `perfStore.ts` | External store shared by probe and HUD (`useSyncExternalStore`) | no |
| `FilterPanel.tsx` | Tier / empty-subnet / AZ / kind (VPC vs global) / edge-kind (4 explicit + 5 inferred) checkboxes, the `showConnectedGlobals` toggle, search (200ms debounce), reset, copy link. Counts come from the unfiltered graph. Emits patches only | no |
| `ChatPanel.tsx` | Natural language → `/api/topology3d-chat` (SSE). Sends the last 10 turns + current filter + `summarizeGraph`, streams text, applies the `filter` event's patch through `onPatch`. Each message remembers the filter before it for undo, shows `diffFilter` chips and `rejected` items. Stop (AbortController), suggestion chips | no |

## Rules
- Every file is `'use client'` with a `export default` component (helpers such as `PerfProbe`, `toNodeItems` are named exports)
- Files that import three/R3F (marked yes) reach the page only through `Scene.tsx`, loaded as `dynamic(() => import('@/components/topology3d/Scene'), { ssr: false })`. HTML panels (`Inspector`, `SourcePanel`) use `colors.ts` and never import `palette.ts`
- **Components own no state.** The filter belongs to `useTopologyFilter` (URL-synced), the source to `useTopologySource`, selection and expansion to the page; only hover is `Scene`-local. `FilterPanel`, `ChatPanel` and the toolbar emit a `TopologyFilterPatch` through `onPatch` and never mutate the filter (ADR-013)
- Never compute positions here; position, size, labels and edge endpoints come from `Layout3D`. Change placement in `src/lib/topology/layout3d.ts`
- Performance: one or two `InstancedMesh` per kind (plaques + stack columns), one tube mesh for all edges, a label cap, `frameloop="demand"` (`always` only during the flow animation). A filter change updates instance matrices and colours instead of rebuilding the scene (the edge tube geometry is rebuilt per layout); an `InstancedMesh` is re-created (via `key`) only when its instance count changes
- Icons come only from the embedded data URIs in `src/lib/fossflow/icons.ts` (no network). A new kind is one line each in `KIND_ICON_ID` and `KIND_LABELS` in `icons.ts`
- Node plaques lean toward the default camera direction (`FitCamera`); change `palette.ICON_TILT` together with it
- Never set React state from per-frame code (`useFrame`): numbers go to `perfStore`, visibility is toggled on `visible` directly
- Copy comes from `t('topology3d.*')` via `useLanguage()`; add every new key to all three of ko/en/zh
- The toolbar's **focus** toggle (`focusEdges`) is page state. `Scene` resolves the selection's indices through `layout.edgeIndexByElement` and `Edges` narrows the geometry. With nothing selected it does nothing — it never forces a selection
- **Explicit and inferred are visually distinct** (ADR-014): inferred edges are dashed, the legend and filter panel group them separately, and the inspector badge gets a dashed border. Never drop the "permitted path, not observed traffic" line
- Tailwind colours are theme tokens only (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`); 3D material colours live only in `colors.ts`
- troika `Text` fetches its default font from a CDN (jsdelivr). Without internet in the browser the labels render empty; the scene itself is unaffected
