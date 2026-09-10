# 토폴로지 어댑터 (`src/lib/topology/adapters/`)

각 어댑터는 서로 다른 입력을 받아 같은 `TopologyGraph`(`../types.ts`)를 낸다. 소비자는 어댑터를 구분하지 않는다.

| 파일 | 입력 | 상태 |
|---|---|---|
| `live.ts` | `src/lib/queries/relationships.ts` 행 (`LiveTopologyRows`, topology-view 페이지의 요청 키와 동일) | Phase 1 |
| `fixture.ts` | JSON (내장 파일 또는 업로드). `validateGraph` 통과 후 `meta.source='fixture'`로 반환 | Phase 2 |
| `generator.ts` | `GeneratorParams` + 시드 (mulberry32, 결정적) | Phase 2 |

## 규칙
- 컬럼명은 `live.ts`에서만 쓴다. 쿼리를 바꾸면 `live.ts`와 `__tests__/fixtures/live-rows.ts`를 같이 고친다
- 결과는 결정적이어야 한다. 시각은 `opts.now`, 난수는 시드로 주입
- 새 어댑터는 `validateGraph`가 빈 배열을 내는지 테스트로 확인한다
- `fixture.ts`는 입력을 신뢰하지 않는다. 실패 시 예외가 아니라 필드별 메시지(`issues`, 20개 상한)를 돌려준다. 예외를 던지는 `toTopologyGraph`는 테스트가 보증하는 내장 픽스처 전용
- 내보낸 그래프를 다시 읽으면 픽스처다. `parseFixture`가 `meta.source`를 `fixture`로 고정하고 `seed`·`anonymized`는 출처 표시로 남긴다
- `generator.ts`의 ID는 실제 AWS 장문 형식(`i-0` + 16 hex)을 따른다. 라이브와 구분되지 않아야 규모 테스트가 의미 있다

---

# Topology Adapters (English)

Each adapter takes a different input and returns the same `TopologyGraph` (`../types.ts`). Consumers cannot tell them apart.

| File | Input | Status |
|---|---|---|
| `live.ts` | rows from `src/lib/queries/relationships.ts` (`LiveTopologyRows`, same keys as the topology-view request) | Phase 1 |
| `fixture.ts` | JSON (built-in file or upload), returned as `meta.source='fixture'` after `validateGraph` passes | Phase 2 |
| `generator.ts` | `GeneratorParams` + seed (mulberry32, deterministic) | Phase 2 |

## Rules
- Column names live only in `live.ts`. A query change updates `live.ts` and `__tests__/fixtures/live-rows.ts` together
- Output must be deterministic: time via `opts.now`, randomness via seed
- A new adapter gets a test asserting `validateGraph` returns an empty array
- `fixture.ts` trusts nothing: a rejected payload comes back as per-field messages (`issues`, capped at 20), not an exception. The throwing `toTopologyGraph` is for built-in fixtures, which tests guarantee
- An exported graph read back in is a fixture: `parseFixture` pins `meta.source` to `fixture` and keeps `seed` and `anonymized` as provenance
- Generator ids follow the real AWS long form (`i-0` + 16 hex). Scale testing only means something if a generated graph is indistinguishable from a live one
