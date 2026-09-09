# ADR-010: TopologyGraph Contract Between Data Sources and Renderers / 데이터 소스와 렌더러 사이의 TopologyGraph 계약

## Status: Accepted (2026-09-09) / 상태: 승인됨

## Context / 컨텍스트

The existing Topology View (`src/lib/fossflow/generator.ts`) read Steampipe rows directly: it knew column names,
decided public/private tiers from route tables, resolved ALB targets through subnet CIDRs, and laid out tiles, all
in one 600-line function. The 3D view needs the same classification but a different renderer, must run without AWS
credentials (fixtures, synthetic generator), and must let checkboxes, URL parameters, and chat drive one filter.
Duplicating the classification per renderer, or feeding rows into three renderers, would triple the column-name
surface and make offline data impossible to plug in.

기존 Topology View는 Steampipe 행을 직접 읽으며 티어 판정, ALB 타겟 해석, 배치를 한 함수에서 처리했다.
3D 뷰는 같은 분류를 다른 렌더러로 그리고, 자격증명 없이도 동작해야 하며, 체크박스·URL·채팅이 하나의 필터를 써야 한다.

## Decision / 결정

- A single data contract, `TopologyGraph` (`src/lib/topology/types.ts`), sits between every source and every consumer:
  `vpcs`, `subnets` (with `tier` already decided), `nodes` (17 `NodeKind`s, AWS id or `${kind}:${name}`, kind-specific
  `meta`), `edges` (`target` / `route` / `attach` / `egress`, endpoints may be node, subnet, or VPC ids), and `meta.source`.
- **Adapters** own everything that depends on the input: `adapters/live.ts` is the only file that knows Steampipe
  column names; fixture and generator adapters (Phase 2) produce the same shape. Tiering, target resolution, and
  drop rules (terminated instances, deleted gateways) happen in the adapter, once.
- **Filtering is pure**: `applyFilter(graph, filter)` in `filter.ts`. Every control path produces a
  `TopologyFilterPatch` merged with `mergeFilter`; unknown kinds/tiers are ignored so model output cannot corrupt state.
  URL serialisation writes only non-default entries.
- The FossFLOW generator keeps its layout code but now takes a `TopologyGraph`. Its output is pinned by a snapshot
  produced from the pre-contract generator (`__tests__/fixtures/fossflow-expected.json`), so the refactor is proven
  pixel-equivalent rather than assumed.
- `validate.ts` reports structural and referential problems as messages; adapters are tested against it.

## Consequences / 결과

| Area | Effect |
|---|---|
| New data source | One adapter file plus a `validateGraph` test. No renderer or filter change |
| Query change | Touch `relationships.ts`, `adapters/live.ts`, and the row fixture together (`vpcSubnets` gained `map_public_ip_on_launch` for the no-route-table fallback) |
| Renderer change | Cannot break classification; parity test guards the FossFLOW view, 3D renderer reads coordinates only |
| Cost | One extra in-memory pass per fetch (rows → graph), negligible next to the 5-minute query cache |
| Testing | `vitest` (`npm test`) covers filter, adapter, validator, and FossFLOW parity without a database |
| Deviation from old view | Deleted NAT gateways and deleted TGW attachments are no longer drawn (they were resources that no longer exist) |
