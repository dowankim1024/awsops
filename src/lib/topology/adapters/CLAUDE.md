# 토폴로지 어댑터 (`src/lib/topology/adapters/`)

각 어댑터는 서로 다른 입력을 받아 같은 `TopologyGraph`(`../types.ts`)를 낸다. 소비자는 어댑터를 구분하지 않는다.

| 파일 | 입력 | 상태 |
|---|---|---|
| `live.ts` | `src/lib/queries/relationships.ts` 행 (`LiveTopologyRows`, topology-view 페이지의 요청 키와 동일) | Phase 1 · 4.6 |
| `fixture.ts` | JSON (내장 파일 또는 업로드). `validateGraph` 통과 후 `meta.source='fixture'`로 반환 | Phase 2 |
| `generator.ts` | `GeneratorParams` + 시드 (mulberry32, 결정적) | Phase 2 |

## 규칙
- 컬럼명은 `live.ts`에서만 쓴다. 쿼리를 바꾸면 `live.ts`와 `__tests__/fixtures/live-rows.ts`를 같이 고친다
- **설정 추론(ADR-014)은 규칙을 갖지 않는다.** 어댑터는 행을 `infer.ts`의 정규화된 사실로 옮기고 `withInferredEdges`를 부를 뿐이다. 새 추론 규칙은 `infer.ts`에 넣는다
- `live.ts`의 추론 입력은 전부 **선택**이다. `sgRules`·`instanceProfiles`·`roles`·`policies`·`eventSourceMappings`·`route53Records`가 하나도 없으면 명시 관계만 있는 이전 그래프가 나온다
- IAM은 3단계로 좁혀 받는다: 1차 조회 → `usedRoleArns(rows)` → `iamRolesQuery` → `attachedPolicyArns(roleRows)` → `iamPoliciesQuery`. 순서를 바꾸거나 좁힘을 빼면 계정의 롤 전체를 읽게 된다(롤 하나당 API 호출 하나)
- 정책 문서는 모양이 여러 가지라 `policyStatements`가 `Statement`를 찾을 때까지 훑는다. 모르는 모양이면 예외가 아니라 빈 배열이다
- 보안그룹은 테이블마다 표현이 다르다(`['sg-…']`, `[{GroupId}]`, `[{VpcSecurityGroupId}]`). 전부 `securityGroupIds()`로 읽는다
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
- **Inference (ADR-014) holds no rules here.** The adapter maps rows onto `infer.ts`'s normalised facts and calls `withInferredEdges`; a new rule goes in `infer.ts`
- Every inference input is optional: with none of `sgRules`, `instanceProfiles`, `roles`, `policies`, `eventSourceMappings`, `route53Records`, the output is the pre-4.6 graph
- IAM arrives in three narrowed steps: first pass → `usedRoleArns(rows)` → `iamRolesQuery` → `attachedPolicyArns(roleRows)` → `iamPoliciesQuery`. Dropping the narrowing means reading every role in the account (one API call each)
- Policy documents come in several shapes, so `policyStatements` walks until it finds `Statement`; an unknown shape yields an empty array, never an exception
- Security groups differ per table (`['sg-…']`, `[{GroupId}]`, `[{VpcSecurityGroupId}]`); all of them go through `securityGroupIds()`
- Output must be deterministic: time via `opts.now`, randomness via seed
- A new adapter gets a test asserting `validateGraph` returns an empty array
- `fixture.ts` trusts nothing: a rejected payload comes back as per-field messages (`issues`, capped at 20), not an exception. The throwing `toTopologyGraph` is for built-in fixtures, which tests guarantee
- An exported graph read back in is a fixture: `parseFixture` pins `meta.source` to `fixture` and keeps `seed` and `anonymized` as provenance
- Generator ids follow the real AWS long form (`i-0` + 16 hex). Scale testing only means something if a generated graph is indistinguishable from a live one
