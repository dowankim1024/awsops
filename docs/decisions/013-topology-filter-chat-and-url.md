# ADR-013: 필터 채팅과 URL 동기화 — 세 경로가 하나의 필터를 쓴다

- 상태: 채택 (2026-09-10, Phase 4)
- 관련: ADR-010 (TopologyGraph 계약), ADR-012 (3D 레이아웃·렌더링), `docs/plans/2026-09-09-topology-3d-and-slimdown.md` §3.2, §3.7, §3.8

## 맥락

체크박스, URL 쿼리, 자연어 채팅이 각자 다른 상태를 들면 "채팅으로 숨긴 것을 체크박스가 모른다"는 식의 어긋남이 생긴다. 기존 `topology-chat`(FossFLOW 뷰)은 다이어그램 모델 전체를 프롬프트에 넣고 응답 텍스트에서 정규식으로 JSON을 긁어냈다. 노드 1,000개 그래프에서는 프롬프트가 커서 느리고 비싸며, 모델 출력이 그대로 씬을 바꾸는 구조라 검증이 약했다.

## 결정

1. **필터 상태는 하나, 소유자는 `useTopologyFilter`다.** 체크박스 패널(`FilterPanel`), 툴바 VPC 셀렉트, 채팅(`ChatPanel`) 모두 `TopologyFilterPatch`를 만들어 `patch()` → `mergeFilter`로 넣는다. 씬은 `applyFilter(graph, filter)` 결과만 받는다. 펼침(`expanded`)과 선택은 필터가 아니라 페이지 UI 상태다.
2. **URL은 필터의 직렬화다.** `filterToSearchParams`가 기본값과 다른 항목만 쓰고(`?vpc=…&tiers=private&hide=lambda&az=…&q=web`), 훅이 `history.replaceState`로 주소를 갱신한다(Next 14.1+가 native replaceState를 `useSearchParams`와 동기화하므로 뒤로/앞으로도 필터로 돌아온다). 링크를 복사하면 같은 뷰가 열린다. `useSearchParams` 때문에 페이지는 `Suspense`로 감싼다.
3. **채팅은 필터 패치만 만든다.** 그래프는 모델에 가지 않는다. 프롬프트에는 `set_filter` 도구 스키마, 현재 필터, 그래프 요약(`summarizeGraph`: VPC 목록, 현재 VPC의 AZ·티어별 서브넷 수·종류별 노드 수)만 들어간다. 요약은 stress 픽스처에서도 1KB 수준이라 프롬프트 크기가 노드 수와 무관하다.
4. **Bedrock `ConverseStream` + `toolConfig`.** 도구는 `set_filter` 하나다. 계획서의 `answer` 도구는 두지 않았다 — 텍스트 델타가 곧 답변이고, 도구 없이 텍스트만 오면 질문에 답한 것이다. 정규식 JSON 추출은 쓰지 않는다. 텍스트는 SSE(`event: text`)로 즉시 흘리고, 도구 입력은 스트림이 끝난 뒤 검증해 `event: filter`로 한 번 보낸다.
5. **모델 출력은 데이터다.** 서버가 `sanitizePatch`로 알 수 없는 kind·tier를 버리고, AZ는 요약의 목록에 대해 정확 일치 → 접미사 일치(`2a`, `a`)로 풀며, VPC는 id 또는 이름으로 푼다. 하나도 못 푼 AZ 목록으로 화면을 비우지 않는다. 버린 항목은 `rejected`로 클라이언트에 보여 준다. 클라이언트가 보낸 필터·요약·대화 이력도 같은 이유로 다시 정규화한다(`sanitizeFilter`, `sanitizeSummary`, `toConverseMessages`).
6. **되돌리기는 클라이언트 책임이다.** 패치를 적용한 메시지는 적용 직전 필터를 기억하고, "되돌리기"는 `setFilter(before)`다. 서버는 대화도 필터도 저장하지 않는다. 이력은 최근 10턴만 보낸다.
7. **순수 부분과 I/O를 나눈다.** 요약·프롬프트·스키마·검증·스트림 리듀서·diff는 `src/lib/topology/chat.ts`, SSE 코덱은 `sse.ts`에 두고 vitest로 검증한다. 라우트(`src/app/api/topology3d-chat`)는 Bedrock 호출과 `ReadableStream` 조립만 한다. Bedrock 없이 리듀서와 검증기를 테스트할 수 있다.

## 결과

- "퍼블릭 서브넷이랑 람다는 빼고 a존만" → `set_filter({ tiers: { public: false }, kinds: { lambda: false }, azs: ['ap-northeast-2a'] })` → 체크박스가 따라 바뀌고 URL이 `?tiers=private&hide=lambda&az=ap-northeast-2a`가 된다. 세 경로의 결과가 같은 함수를 거치므로 같다
- 프롬프트가 작아 응답이 빠르고(첫 토큰 1초 안팎) 모델을 작은 것으로 바꿔도 된다(`config.topology3d.chatModelId`)
- 채팅이 실패해도(모델 접근 미활성, 자격증명 없음) 필터 패널과 URL은 독립적으로 동작한다. Fixture·Generator 모드는 채팅만 빼고 오프라인이다
- 라우트 호출은 배포 계정의 실제 Bedrock 과금이다. 로컬 개발에서는 자격증명이 있으면 그대로 과금되므로 확인 없이 호출하지 않는다
- 한계: 채팅은 펼침·카메라·색을 바꾸지 못한다(의도). 스트리밍 중 체크박스를 누르면 패치는 최신 필터 위에 합쳐진다

---

# ADR-013: Filter Chat and URL Sync — Three Paths, One Filter (English)

- Status: accepted (2026-09-10, Phase 4)
- Related: ADR-010 (TopologyGraph contract), ADR-012 (3D layout and rendering), `docs/plans/2026-09-09-topology-3d-and-slimdown.md` §3.2, §3.7, §3.8

## Context

If checkboxes, the URL query and natural-language chat each held their own state, they would drift ("the checkboxes don't know what the chat hid"). The existing `topology-chat` (FossFLOW view) puts the whole diagram model into the prompt and regex-scrapes JSON out of the reply. At 1,000 nodes that prompt is slow and expensive, and model output changed the scene with little validation in between.

## Decision

1. **One filter state, owned by `useTopologyFilter`.** The checkbox panel (`FilterPanel`), the toolbar VPC select and the chat (`ChatPanel`) all produce a `TopologyFilterPatch` and feed it through `patch()` → `mergeFilter`. The scene only sees `applyFilter(graph, filter)`. Expansion and selection are page UI state, not filter state.
2. **The URL is a serialisation of the filter.** `filterToSearchParams` writes only non-default entries (`?vpc=…&tiers=private&hide=lambda&az=…&q=web`) and the hook updates the address with `history.replaceState` (Next 14.1+ syncs native replaceState with `useSearchParams`, so back/forward restore the filter too). Copying the link reopens the same view. The page is wrapped in `Suspense` because of `useSearchParams`.
3. **Chat produces filter patches only.** The graph never reaches the model. The prompt carries the `set_filter` tool schema, the current filter and a graph summary (`summarizeGraph`: VPC list, and for the current VPC its AZs, subnet count per tier, node count per kind). The summary stays around 1KB even for the stress fixture, so prompt size is independent of node count.
4. **Bedrock `ConverseStream` with `toolConfig`.** There is one tool, `set_filter`. The plan's `answer` tool was dropped: text deltas are the answer, and a reply with no tool call is an answer to a question. No regex JSON extraction. Text streams immediately as SSE (`event: text`); the tool input is validated after the stream ends and sent once as `event: filter`.
5. **Model output is data.** The server runs `sanitizePatch`: unknown kinds/tiers are dropped, AZs resolve against the summary by exact then suffix match (`2a`, `a`), VPCs by id or name. An AZ list that resolves to nothing never blanks the scene. Dropped items go back to the client as `rejected`. The filter, summary and history sent by the client are re-normalised for the same reason (`sanitizeFilter`, `sanitizeSummary`, `toConverseMessages`).
6. **Undo is the client's job.** A message that applied a patch remembers the filter from just before; "undo" is `setFilter(before)`. The server stores neither conversation nor filter. Only the last 10 turns are sent.
7. **Pure parts are separated from I/O.** Summary, prompt, schema, validation, stream reducer and diff live in `src/lib/topology/chat.ts`, the SSE codec in `sse.ts`, both under vitest. The route (`src/app/api/topology3d-chat`) only calls Bedrock and assembles a `ReadableStream`. The reducer and validator are testable without Bedrock.

## Consequences

- "hide public subnets and lambdas, only zone a" → `set_filter({ tiers: { public: false }, kinds: { lambda: false }, azs: ['ap-northeast-2a'] })` → the checkboxes follow and the URL becomes `?tiers=private&hide=lambda&az=ap-northeast-2a`. All three paths go through the same function, so they agree
- The small prompt keeps replies fast (first token around a second) and allows a cheaper model later (`config.topology3d.chatModelId`)
- When chat fails (model access not enabled, no credentials) the filter panel and URL keep working on their own. Fixture and Generator modes are offline except for chat
- Each route call is real Bedrock usage billed to the deployment account. Local development with credentials bills the same way, so the route is never invoked without asking
- Limits: chat cannot change expansion, camera or colours (by design). Checkbox clicks during streaming are kept; the patch merges on top of the latest filter
