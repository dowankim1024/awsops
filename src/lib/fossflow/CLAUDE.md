# FossFLOW 모듈 (`src/lib/fossflow/`)

기존 Topology View(`src/app/topology-view/`)가 쓰는 아이소메트릭 모델 생성기와 채팅 패치 도구. 3D 토폴로지 뷰와는 별개이며, 유지만 한다.

- `generator.ts` — `buildFossflowModel(graph: TopologyGraph, vpc, opts)`. Phase 1부터 Steampipe 행 대신 `TopologyGraph`(`src/lib/topology/types.ts`)를 받는다. 행 → 그래프 변환은 `src/lib/topology/adapters/live.ts`. `listVpcs(graph)`는 `graph.vpcs`
- `icons.ts` — FossFLOW 아이콘 세트
- `patch.ts` — RFC 6902 부분 구현 (add/remove/replace). topology-chat의 LLM 패치 적용
- `validate.ts` — FossFLOW 모델 구조 검증 (LLM 패치 게이트)

## 규칙
- 생성기 산출물은 `src/lib/topology/__tests__/fossflow-parity.test.ts`의 스냅샷과 같아야 한다. 의도한 시각 변경이면 스냅샷을 갱신하고 커밋 메시지에 남긴다
- 레이어 토글(`TopologyOptions`)은 이 뷰 전용이다. 3D 뷰는 `TopologyFilter`를 쓴다

---

# FossFLOW Module (English)

Isometric model generator and chat-patch helpers for the existing Topology View (`src/app/topology-view/`). Separate from the 3D view; maintenance only.

- `generator.ts` — `buildFossflowModel(graph: TopologyGraph, vpc, opts)`. Since Phase 1 it consumes a `TopologyGraph` (`src/lib/topology/types.ts`) instead of Steampipe rows; rows are converted by `src/lib/topology/adapters/live.ts`. `listVpcs(graph)` returns `graph.vpcs`
- `icons.ts` — FossFLOW icon set
- `patch.ts` — partial RFC 6902 (add/remove/replace) for topology-chat LLM patches
- `validate.ts` — FossFLOW model structure checks (gates LLM patches)

## Rules
- Generator output must match the snapshot in `src/lib/topology/__tests__/fossflow-parity.test.ts`. For an intended visual change, regenerate the snapshot and say so in the commit message
- Layer toggles (`TopologyOptions`) belong to this view only; the 3D view uses `TopologyFilter`
