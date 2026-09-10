# Hooks Module

## 역할
커스텀 React 훅. 페이지가 들고 있기엔 큰 상태 로직을 떼어낸다. 계정 컨텍스트는 훅이 아니라 `@/contexts/AccountContext`의 `useAccountContext()`를 직접 쓴다.

## 파일
- `useTopologySource.ts` — 3D 토폴로지 뷰의 데이터 소스. Live(`POST /api/steampipe` + `relationships.ts` 쿼리 18종 → `adapters/live`), Fixture(내장 JSON 또는 업로드 → `parseFixture`), Generator(`generateGraph`, 시드 기반) 세 갈래가 모두 같은 `TopologyGraph`를 낸다. 프리셋·파라미터·시드, 검증 실패 메시지(`issues`), JSON 내보내기(익명화 선택)를 포함. `SourcePanel`이 반환 객체를 그대로 받는다
- (Phase 4) `useTopologyFilter.ts` — `TopologyFilter`와 URL 쿼리 동기화

## 규칙
- 모든 훅에 `'use client'`
- 이름 있는 내보내기 (`export function useXxx()`)
- fetch URL은 반드시 `/api/*` 접두사
- 응답이 늦게 온 요청이 최신 상태를 덮지 않도록 요청 토큰(`useRef`)으로 막는다
- 순수 로직(어댑터, 필터, 레이아웃)은 훅이 아니라 `src/lib/topology/`에 둔다. 훅은 상태와 부수효과만 맡는다

---

# Hooks Module (English)

## Role
Custom React hooks: state logic too big to sit in a page. Account context is not a hook here — pages call `useAccountContext()` from `@/contexts/AccountContext` directly.

## Files
- `useTopologySource.ts` — the 3D topology view's data source. Live (`POST /api/steampipe` with the 18 `relationships.ts` queries → `adapters/live`), Fixture (built-in JSON or an upload → `parseFixture`), and Generator (`generateGraph`, seeded) all resolve to the same `TopologyGraph`. Carries presets, params and seed, per-field validation messages (`issues`), and JSON export with optional anonymization. `SourcePanel` renders the returned object as-is
- (Phase 4) `useTopologyFilter.ts` — `TopologyFilter` with URL query synchronization

## Rules
- Every hook is `'use client'`
- Named exports (`export function useXxx()`)
- All fetch URLs use the `/api/*` prefix
- Guard against a late response overwriting newer state with a request token (`useRef`)
- Pure logic (adapters, filter, layout) belongs in `src/lib/topology/`, not here; hooks own state and effects only
