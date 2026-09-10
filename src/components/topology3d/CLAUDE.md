# 3D 토폴로지 컴포넌트 (`src/components/topology3d/`)

## 역할
3D 토폴로지 뷰의 UI. 렌더러는 `TopologyGraph`(`@/lib/topology/types`)만 받고 Steampipe를 모른다. 상태는 페이지와 훅(`@/hooks/useTopologySource`, Phase 4의 `useTopologyFilter`)이 들고, 컴포넌트는 받은 것을 그리고 콜백만 호출한다.

## 파일
| 파일 | 역할 | 상태 |
|---|---|---|
| `SourcePanel.tsx` | Live / Fixture / Generator 전환. 생성기 프리셋·시드·슬라이더, 픽스처 선택과 업로드, 내보내기(익명화 포함), 그래프 요약 | Phase 2 |
| `Scene.tsx` `Ground.tsx` `InstancedNodes.tsx` `Edges.tsx` `Labels.tsx` `Inspector.tsx` `PerfHud.tsx` | 렌더러 | Phase 3 |
| `FilterPanel.tsx` `ChatPanel.tsx` | 필터 체크박스, 자연어 채팅 | Phase 4 |

## 규칙
- 모든 파일 `'use client'`. `export default` 컴포넌트
- three/R3F를 쓰는 컴포넌트는 페이지에서 `dynamic(() => import(...), { ssr: false })`로만 불러온다
- **컴포넌트는 상태를 소유하지 않는다.** `SourcePanel`은 `useTopologySource`가 반환한 객체를 `source` prop으로 받아 그대로 그린다. 로딩·검증·내보내기는 훅에 있다
- 문구는 `useLanguage()`의 `t('topology3d.*')`. 새 문구는 ko/en/zh 세 파일 모두에 넣는다
- 색은 테마 토큰만 (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`)
- 성능: 노드는 종류별 `InstancedMesh`, 엣지는 단일 `LineSegments`, 라벨 상한, `frameloop="demand"`. 필터가 바뀌어도 씬을 새로 만들지 않고 인스턴스 행렬만 갱신한다

---

# 3D Topology Components (English)

## Role
UI for the 3D topology view. The renderer consumes `TopologyGraph` (`@/lib/topology/types`) and never sees Steampipe. State lives in the page and its hooks (`@/hooks/useTopologySource`, and `useTopologyFilter` in Phase 4); components draw what they are handed and call back.

## Files
| File | Role | Status |
|---|---|---|
| `SourcePanel.tsx` | Switches Live / Fixture / Generator. Generator presets, seed and sliders; fixture picker and upload; export (with anonymization); graph summary | Phase 2 |
| `Scene.tsx` `Ground.tsx` `InstancedNodes.tsx` `Edges.tsx` `Labels.tsx` `Inspector.tsx` `PerfHud.tsx` | Renderer | Phase 3 |
| `FilterPanel.tsx` `ChatPanel.tsx` | Checkbox filters, natural-language chat | Phase 4 |

## Rules
- Every file is `'use client'` with a `export default` component
- Anything touching three/R3F is imported by the page through `dynamic(() => import(...), { ssr: false })`
- **Components own no state.** `SourcePanel` takes the object returned by `useTopologySource` as its `source` prop and renders it; loading, validation and export live in the hook
- Copy comes from `t('topology3d.*')` via `useLanguage()`; add every new key to all three of ko/en/zh
- Colors are theme tokens only (`navy-900/800/700/600`, `accent-cyan/green/purple/orange/red`)
- Performance: one `InstancedMesh` per kind, one `LineSegments` for all edges, a label cap, `frameloop="demand"`. A filter change updates instance matrices instead of rebuilding the scene
