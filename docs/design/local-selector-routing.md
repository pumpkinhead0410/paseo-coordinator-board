# 코디네이터 보드 모델 배정을 로컬 프로필 Selector로 위임하는 설계 (합성본)

## Problem

`coordinator-board`는 자체 추천표(`shared/dispatch.ts` `recommendations` → `preferCapacity`)로 모델을 고릅니다. 이 표는 만료된 Fable을 A·B 기본값으로 쓰고, AGY를 사실상 배정하지 않으며, AGY Gemini 한도와 3P 한도를 합쳐 비교합니다. 호스트에는 같은 일을 하는 원본 정책 `paseo/profile_selector.py`(36개 프로필, 4개 한도 풀 균일 분산)가 있으므로, 보드는 이 Selector에 선택을 맡깁니다.

설계가 지켜야 할 제약은 다음과 같습니다.

- **사용자 확정 결정 5개**
  1. 등급 연결: A=deep·xhigh, B=deep·high, C=work·high, D=work·medium, M=deep·high
  2. Selector가 실패하면 배정을 보류하고 사유를 표시합니다. 내장 추천표로 되돌아가지 않습니다.
  3. 보드가 직접 `claim-query` → 명령 → `finish-query` 순서로 사용량을 갱신합니다.
  4. 사용자가 저장한 등급별 순서가 Selector보다 우선합니다.
  5. AGY도 코디네이터(M)로 만들 수 있습니다.
- **화면(client)은 프로세스를 실행하지 못합니다.** 그런데 `client/route-editor.tsx:66`과 `client/operations.tsx:165`가 배정 결과를 미리 보여 줍니다.
- **Selector의 동률 분산에는 상태가 없습니다.** 5분 단위 시간 구간으로 동률을 나누기 때문에, 미리보기(`plan_board_assignment`)와 실제 배정(`dispatchWorker`의 같은 경로 검사)의 결과가 어긋날 수 있습니다.
- **`requiredProfileId`를 지정하면 Selector가 전문화 프로필 격리를 건너뜁니다**(`profile_selector.py:136`). 또 범위가 그 프로필 하나로 줄어서, 그 프로필이 소진되면 결과가 `all-exhausted`로 나옵니다.
- **`paseo usage --json`은 최상위 배열을 출력합니다**(`tests/paseo-quota-state/verify_native.mjs`).
- **업스트림 저장소가 계속 갱신됩니다.** 그래서 변경은 대부분 새 파일에 두고, 기존 파일은 작은 수정 덩어리로만 고칩니다.

## Usage (caller's view)

```ts
// server/operations.ts — plan_board_assignment
const { decisions } = await router.plan(workerGrades, { scope, catalog, needsHooks }, "await");
// decisions.C = { kind:"ready", source:"selector", route:{provider:"antigravity",model:"gemini-4-hydrogen",effort:"high"},
//                 modeId:"auto", profileId:"work.agy.hydrogen.high", why:"… via tier among 4 eligible" }
// decisions.A = { kind:"held", source:"selector", hold:{ code:"all-exhausted", earliestResetAt:"…", detail:"…" } }

// server/dispatch.ts — dispatchWorker (새로 만드는 경로만. 같은 요청 키 재전송은 지금처럼 검증을 건너뜀)
const d = await router.confirm(input.grade, input.expectedRoute, { scope, catalog, needsHooks: input.needsHooks });
if (d.kind === "held") throw new Error(holdText(d.hold, korean));
await workspace.agents.create({ config: { ...configForRoute(d.route), modeId: d.modeId }, ... });

// server/operations.ts — operationState(설정·첫 화면): 사용량 명령을 기다리지 않음
const routes = await router.plan(settings ? allGrades : ["M"], { scope, catalog }, "background");
// 응답에 data.routes = { decisions, refreshing } 를 추가
```

```tsx
// client/route-editor.tsx, client/operations.tsx — resolveRoute import 제거
const decision = data.routes.decisions[grade];
const route = decision?.kind === "ready" ? decision.route : null;
{decision?.kind === "held" && <Text style={muted}>{holdText(decision.hold, t)}</Text>}
```

`plan_board_assignment`가 코디네이터에게 돌려주는 등급 항목의 예입니다.

```json
{"grade":"A","route":null,"expectedModeId":null,
 "hold":{"code":"all-exhausted","message":"모든 후보의 한도가 소진되어 보류했습니다. 11월 25일 11:33 이후 다시 시도하세요."}}
```

## Shape

### 모듈 (새 파일 3개, 호출 경로는 파일 3개 이내)

| 모듈 | 소유하는 지식 | 감추는 것 |
|---|---|---|
| `shared/route-decision.ts` | 결과 형식 | `GRADE_SPEC`(등급→역할·강도, 이 표 하나뿐), `RouteDecision`·`HoldCode` 스키마, `holdText(hold, t)`(유일한 문구 생성기) |
| `server/routes.ts` (`Router`) | 배정 정책 | 저장 순서 우선, 보드 허용 필터, 미리보기(plan)와 실제 배정(confirm)의 의미 차이, 보류 매핑, 여러 등급에 한 번만 하는 갱신, 권한 모드 결정 |
| `server/profile-host.ts` (`ProfileHost`) | 호스트와의 통신 | 저장소 위치 찾기(매번 `realpath`), python 실행, Selector·quota_state의 JSON 스키마(비공개 zod), 잠금 재시도, 조회권→명령→반영 절차, 명령 허용 목록, lease 안의 시간 제한, 프로세스 그룹 종료, 동시 요청 묶기 |

`child_process`는 `profile-host.ts`에만 둡니다. `Router`의 공개 메서드는 `plan`과 `confirm` 두 개이고, `ProfileHost`는 `rank`, `describe`, `refresh` 세 개이며 예외를 던지지 않고 결과 타입을 돌려줍니다.

### 핵심 자료구조

```ts
type RouteDecision =
  | { kind: "ready"; source: "saved" | "selector"; route: RouteChoice; modeId?: string; profileId?: string; why?: string }
  | { kind: "held";  source: "saved" | "selector"; hold: Hold };
type Hold = { code: HoldCode; detail?: string; earliestResetAt?: string };
type HoldCode =
  | "selector-unavailable"  // 스크립트·저장소 경로 없음, 실행 실패, 출력 파싱 실패
  | "selector-defer"        // exit 2 (잠금 경합 재시도 후에도, 손상·스키마 불일치)
  | "no-match" | "all-exhausted"
  | "board-filtered"        // Selector 후보는 있으나 보드 조건(카탈로그·제외·훅·코디네이터 모드)을 모두 통과하지 못함. detail에 원인별 개수
  | "plan-changed"          // confirm: 기대 경로가 현재 허용 후보 목록에 없음 → 코디네이터가 다시 plan
  | "saved-unavailable";    // 저장 순서의 후보를 이 호스트에서 쓸 수 없음
```

### 미리보기와 실제 배정의 일관성 (핵심 결정)

두 동작이 같은 비공개 함수 `allowedCandidates(grade, ctx)` 하나를 씁니다.

1. `ProfileHost.rank(role, effort)`가 Selector를 `topN: 10`으로 자유 선택 호출합니다(`requiredProfileId` 없음). 결과는 `selected`와 `alternatives`를 합친 순위 목록입니다. 한 역할·강도 범위의 프로필은 현재 4~5개이므로 목록이 전체를 덮습니다. `alternatives.length === topN`이면 덮지 못했을 수 있으니 `board-filtered` 대신 `selector-defer`로 보류합니다.
2. `boardAllows(candidate, grade, ctx)`로 거릅니다. 통과 조건은 다음과 같습니다.
   - 실행기가 `scope.excludedProviders`에 없습니다.
   - 카탈로그에 해당 (provider, model)과 등급 강도가 있습니다.
   - `eligibleProvider(grade, provider, needsHooks, catalog)`를 통과합니다. 훅 규칙은 기존 함수를 재사용하고, A·B·M의 claude·codex 제한은 이번에 제거합니다.
   - M이면 카탈로그의 `coordinatorMode`가 있습니다.
3. **plan**은 통과한 첫 후보를 고릅니다. 그 후보가 Selector의 `selected`가 아니면 `describe(profileId)`(`requiredProfileId` 호출)로 `modeId`와 `thinkingOptionId`를 받아 옵니다. 이 후보는 이미 자유 선택에서 적격으로 나온 것이라 격리 우회가 생기지 않습니다.
4. **confirm**은 기대 경로 (provider, model, effort)가 통과 목록에 있는지만 봅니다. 있으면 `ready`, 없으면 `plan-changed`로 보류합니다. Selector 자체가 `all-exhausted`나 `no-match`를 내면 그 코드로 보류합니다.

이렇게 하면 시간 구간이 바뀌거나 잔여율이 조금 움직여도, 미리보기한 후보가 여전히 적격·비소진이면 배정이 통과합니다. 소진·제외·전문화 위반은 거부됩니다. 특정 프로필 하나만 소진됐을 때는 "전체 소진"이 아니라 "재계획 필요"로 보고합니다. 저장 순서 경로는 업스트림의 `sameRoute` 일치 검사를 그대로 유지합니다.

### 저장 순서(결정 4)와 내장 추천표(결정 2)

- `savedDecision`은 업스트림 `resolveRoute`를 해당 등급이 반드시 들어 있는 정책으로 호출합니다. 따라서 `recommendations` 분기는 실행되지 않습니다.
- `recommendations`와 `preferCapacity`는 업스트림 병합을 쉽게 하려고 파일에 남깁니다. 대신 `test/route-boundary.test.ts`가 다음 경우에 실패하게 해서 구조적으로 막습니다.
  - `server/routes.ts`가 아닌 파일이 `resolveRoute`나 `preferCapacity`를 import하는 경우
  - `child_process`가 `profile-host.ts` 밖에서 쓰이는 경우
- `shared/dispatch.ts`의 수정은 `eligibleProvider`의 A·B·M claude·codex 제한을 제거하는 작은 덩어리 하나뿐입니다. 이 제한이 남아 있으면 저장 경로와 설정 화면에서 AGY를 고를 수 없습니다.

### 권한 모드

- Selector 경로: `scope.workerModeOverrides[provider] ?? profile.modeId`. 사용자가 명시한 재정의가 우선하고, 기본은 프로필 값(AGY는 `auto`)입니다.
- 저장 경로: 기존 `effectiveWorkerMode`를 씁니다. `recommendedWorkerMode`에 `antigravity → auto`를 추가해, AGY가 provider 기본값인 `full-access`로 생성되지 않게 합니다.
- M(결정 5): `server/dispatch.ts`의 `coordinatorModes`에 `["antigravity", ["auto"]]`를 추가합니다. `server/lifecycle.ts`의 `verifyCoordinatorRuntime`은 antigravity도 opencode·copilot처럼 도구 호출과 MCP 지원, 권한 모드를 확인합니다.

### 사용량 갱신

- `plan(…, "await")`(코디네이터 도구): 등급별 `claimCandidates`를 합쳐 **한 번만** 갱신하고 다시 선택합니다. 최대 Selector 호출은 등급 수의 두 배와 명령 1회입니다.
- `plan(…, "background")`(설정·첫 화면): 현재 상태로 바로 응답하고 갱신은 기다리지 않습니다. `refreshing: true`를 표시하고, 화면은 약 5초 뒤 한 번 다시 조회합니다.
- `confirm`: 갱신하지 않습니다. 현재 공유 상태로만 판정하고, 소진이면 보류해 코디네이터가 다시 plan하게 합니다.
- 갱신 절차:
  - `claimed:true`일 때만 반환된 명령을 실행합니다. 허용 목록은 `["paseo","usage"]`와 `--json`·`--refresh`이며, 셸 없이 실행합니다.
  - 시간 제한은 `min(25s, lease − 경과 − 10s)`입니다. 프로세스 그룹으로 실행하고 시간이 넘으면 `kill(-pid, SIGKILL)`한 뒤 `finish-query({connectionError:true})`를 보냅니다.
  - 출력은 최상위 배열 그대로 `reports`에 넣습니다.
  - `claimed:false`(다른 세션이 조회 중이거나 아직 갱신할 때가 아님)면 기다리지 않고 현재 상태를 씁니다.
  - 같은 데몬 안의 동시 요청은 하나의 갱신으로 묶습니다.
- Selector가 exit 2를 내고 사유가 잠금 경합이면 250ms 뒤 한 번만 다시 시도합니다. 손상·스키마 오류는 재시도하지 않고 곧바로 보류합니다.
- `RefreshOutcome`(`refreshed | skipped | failed`)을 돌려받아, `skipped`나 `failed`면 다시 선택하지 않습니다.

### 보류 표시

- **코디네이터**: `plan_board_assignment`의 각 등급 항목에 `hold{code,message,earliestResetAt}`를 추가합니다. 도구 설명에는 "보류된 등급은 배정하지 말고 사유를 사람에게 전하라. `plan-changed`이면 다시 plan하라"는 한 줄을 넣습니다. `assign_board_worker`는 `holdText`를 오류로 돌려줍니다.
- **사용자**: 설정의 모델 배정 화면에 등급별 출처(저장 / 로컬 Selector), 경로, Selector가 고른 이유, 보류 문구를 표시합니다. M 미리보기가 보류면 코디네이터 생성 버튼을 비활성화합니다. `operationState`는 Selector가 실패해도 예외를 던지지 않습니다.
- **`usageRouting` 토글**: 숨기고 "모델 배정은 이 호스트의 로컬 Selector 정책을 따릅니다"라는 안내로 바꿉니다. `scope.json`의 필드는 하위 호환을 위해 남깁니다. 계정별 잔여량 카드는 유지합니다.

## Synthesis decision

- **기반**: 후보 1(Claude Opus 5.5)의 모듈 구조를 기반으로 삼았습니다. Router와 ProfileHost 분리, 등급 묶음 갱신, 화면 쪽 비차단 갱신, 프로세스 그룹 종료, 보류를 하나의 타입으로 표현하는 방식, 경계 시험이 여기서 왔습니다.
- **교차 심사자**: `antigravity/gemini-4-neon`(high)는 후보 2를 기반으로 추천했습니다(26점 대 19점). 심사자가 지적한 후보 1의 치명 결함 두 가지는 실제 코드로 확인했습니다. 하나는 `requiredProfileId` 재확인이 격리를 우회하고 `all-exhausted`를 잘못 보고하는 문제, 다른 하나는 `paseo usage --json` 형식을 잘못 가정한 문제입니다. 두 결함 모두 아래 이식으로 해소되므로 기반은 그대로 두었습니다.
- **후보 2(Gemini 4 Neon)에서 이식한 것**:
  1. 일관성 메커니즘: 자유 선택한 순위 목록에 들어 있는지 확인하는 방식. 단, 후보 2와 달리 plan과 confirm이 같은 `allowedCandidates`를 공유합니다.
  2. 보류 코드 세분화와 `operationState` 무예외 원칙
  3. 경로를 매번 `realpath`로 다시 찾기
  4. 잠금 경합만 재시도하고 손상은 즉시 보류하기
  5. 실제 `profile_selector.py`를 임시 프로필·상태 파일에 연결한 계약 시험
  6. AGY 코디네이터 지원(`coordinatorModes`에 추가, 결정 5)
- **기각한 것**:
  - 후보 1의 `requiredProfileId` 재확인과 `agent-profiles.json`을 TypeScript에서 직접 읽어 `excludeProfileIds`를 만드는 방식(파서 중복)
  - 후보 2의 `SELECTOR_PROVIDERS` 손 복제 목록(같은 목록을 두 곳에서 맞춰야 함). 보드 제외 조건은 Selector 입력이 아니라 순위 목록 사후 필터로 처리해 Python 목록을 복제하지 않습니다.
  - 후보 2의 선택 후 단일 후보 보류(다른 풀이 건강해도 보류됨). 순위 목록 전체를 필터로 해결합니다.
  - 후보 2의 다른 세션 lease 3초 대기와 `operationState` 동기 갱신(화면 지연)
  - 업스트림 함수 삭제(diff 확대). 경계 시험으로 대체합니다.

## Tradeoffs accepted

- 실제 배정 시점에 미리보기한 후보가 "여전히 1순위"임을 보장하지 않습니다. 적격·비소진이면 통과시키는 대신, 새로운 상태 저장 없이 불일치를 없앱니다.
- 업스트림 `recommendations`와 `preferCapacity`는 이 포크에서 죽은 코드로 남습니다. 경계 시험으로 다시 쓰이지 못하게 막고, 대신 업스트림 파일의 diff를 최소로 유지합니다.
- `confirm`은 갱신하지 않습니다. 가끔 "소진 → 재계획" 왕복이 생기는 대신, 배정 경로에 네트워크 명령과 lease 대기가 없습니다.
- 설정 화면은 몇 초 동안 갱신 전 데이터를 보여 줄 수 있습니다(`refreshing`). 대신 화면이 사용량 조회 때문에 멈추지 않습니다.
- `topN: 10` 상한: 한 역할·강도 범위의 프로필이 11개를 넘으면 `selector-defer`로 보류합니다. 조용히 누락하지 않습니다.

## Alternatives considered

- **seed 공유**: plan 시점에는 요청 키가 없어서 도구 입력 스키마와 코디네이터 프로토콜을 바꿔야 합니다. 잔여율이 바뀌면 같은 seed로도 순위가 뒤집혀 해결도 되지 않습니다.
- **plan 예약표 저장**: `scope.json`에 쓰는 주체가 하나 더 생기고, 만료와 정리가 필요합니다. 순위 목록 확인으로 같은 보장을 상태 없이 얻습니다.
- **TypeScript로 Selector 재구현**: 순위 규칙, 전문화 격리, AGY 창 이전, 부팅·시계 판정을 중복 구현해야 합니다. 원본 정책과 어긋나게 됩니다.
- **별도 미리보기 RPC**: `operationState`의 `revision`과 어긋날 수 있는 두 번째 조회가 생깁니다.

## Test plan

- `test/routes.test.ts`(가짜 ProfileHost, 순수 함수):
  - 등급 표가 Selector에 넘기는 값
  - 저장 순서 우선과 `saved-unavailable`
  - 실패 4종이 내장 추천표 없이 보류로 매핑됨
  - **불일치 회귀**: 순위 1위가 X에서 Y로 바뀌어도 X가 목록에 있으면 `confirm(X)`가 ready, X가 빠지면 `plan-changed`
  - 전문화 프로필은 자유 순위에 없으므로 거부됨
  - `boardAllows`(제외 실행기, 카탈로그 누락, 강도 누락, `needsHooks`로 AGY 제외, M의 `coordinatorMode`)
  - 여러 등급의 갱신이 1회만 일어남
  - `background` 모드가 갱신을 기다리지 않음
  - 권한 모드 재정의 우선
- `test/profile-host.test.ts`(임시 폴더의 가짜 스크립트와 가짜 `paseo`):
  - 경로 없음
  - exit 2 잠금 재시도와 손상 시 즉시 보류
  - 깨진 출력
  - `claimed:false`면 명령 0회
  - 시간 초과 시 프로세스 그룹 종료와 `connectionError`
  - 허용 목록 밖 명령 거부
  - 동시 요청 묶기
- `test/profile-host.contract.test.ts`: 실제 `profile_selector.py`와 `quota_state.py`를 임시 `--profiles`·`--state`로 호출해 JSON 계약을 확인합니다. 실제 사용자 상태 파일은 쓰지 않습니다.
- `test/route-boundary.test.ts`: import 경계와 `child_process` 위치
- 기존 `dispatch.test.ts`와 `operations.test.ts`는 가짜 Router를 주입해 요청 키 재전송과 영수증 검사를 유지합니다.
- `tsc --noEmit`, `bun test ./test`
- 실제 동작 확인:
  - 플러그인을 reload하고 설정 화면에 등급별 결과와 보류 문구가 표시되는지
  - AGY 코디네이터를 생성한 뒤 보드 도구 7개가 보이는지
  - 코디네이터로 작업자 1건을 배정했을 때 AGY 작업자의 권한 모드가 `auto`인지

## Open questions and risks

- 저장 경로에서 AGY를 허용하려고 `eligibleProvider`의 제한을 제거하면, 업스트림의 "Claude Code·Codex가 있으면 A·B는 그 둘만" 규칙이 저장 순서 편집기에서도 사라집니다. 이는 4개 풀 정책에 맞춘 의도된 변경입니다.
- AGY는 Paseo 플러그인 실행기(`plugin:` 세션)입니다. 보드의 `defineAgentTool` 도구가 실제로 붙는지는 실동작으로 확인해야 합니다. 실패하면 M 후보에서 AGY를 빼는 필터 한 줄로 되돌립니다.

## Next implementation step

`test/routes.test.ts`의 불일치 회귀 시험을 가짜 ProfileHost로 먼저 작성하고, `server/routes.ts`의 `allowedCandidates`·`plan`·`confirm`을 구현해 통과시킵니다.

## Implementation reconciliation

구현은 확정 결정 5개를 바꾸지 않았습니다. 설계와 달라지거나 설계가 정하지 않았던 부분은 다음과 같습니다.

1. **`rank`의 대안 후보 표현**: Selector의 `alternatives`에는 강도와 권한 모드가 없습니다. 강도는 프로필 ID의 마지막 토큰(`describe()`가 `thinkingOptionId`와 같다고 검증하는 값)으로 정하고, 권한 모드는 `describe()`로 받아 옵니다. `describe()` 결과의 경로가 순위 목록의 경로와 다르면 `selector-defer`로 보류합니다(현재 프로필 파일에서는 일어나지 않는 방어).
2. **순위 목록이 잘렸을 때**: 설계는 "필터 결과가 비었을 때" `selector-defer`로 보류한다고 했습니다. `confirm`에서 기대 경로가 목록에 없을 때도 같은 규칙을 적용했습니다(잘린 목록에서 "없다"고 결론 내리지 않습니다).
3. **`routingInputs` → `routingFingerprint(scope, grade, provider?)`**: 비동기 판정 뒤 설정 변경을 감지하는 값입니다. 권한 모드 재정의는 해당 실행기의 값만 담습니다. 기존의 "작업 권한 설정이 바뀌었습니다" 별도 오류는 "배정 설정이 바뀌었습니다"로 합쳐졌습니다.
4. **`refreshing` 의미**: `background` 모드에서 갱신 후보가 있으면 `refreshing: true`입니다. 조회권을 실제로 얻었는지는 기다리지 않으므로 알 수 없습니다. 화면은 응답마다 한 번만(자기가 일으킨 재조회에는 다시 걸지 않음) 5초 뒤 재조회합니다.
5. **보류 `detail`**: Selector의 `reason`이나 보드 필터 원인 개수(`no-hooks×1` 같은 언어 중립 코드)를 그대로 담습니다. 번역하지 않습니다.
6. **M의 `modeId`**: 코디네이터 결정의 `modeId`는 프로필 값이 아니라 카탈로그의 `coordinatorMode.id`입니다(`setupCoordinator`의 기존 검증과 같은 값).
7. **`plan_board_assignment` 보류 항목**에 `expectedModeId: null`을 함께 넣었습니다(설계 예시를 따름).
8. **`ProfileHost` 시험용 이음새**: `guidePath`, `profilesPath`, `statePath`, `env`, `python`, `lockRetryMs`, `commandCapMs`, `clock` 옵션을 추가했습니다. 기본값은 설계와 같습니다(`realpath(~/.agents/guides/paseo.md)` 매번 조회, `python3`, 250ms 재시도, 25초 상한).
9. **기존 시험 갱신**: A·B·M의 claude·codex 제한을 제거한 결과로 `dispatch.test.ts`, `usage-routing.test.ts`, `route-options.test.ts`의 기대값을 바꿨습니다(A·B는 모든 실행기 허용). 사용량 기반 배정 시험은 로컬 Router 결정 시험으로 대체했습니다. `operations.test.ts`·`dispatch.test.ts`는 `test/legacy-router.ts`(업스트림 추천표로 판정하는 가짜 Router)를 주입하고, "미리보기" 오류 문구 대신 보류 문구를 기대합니다.
10. **문구 변경**: 편집기의 "추천으로 복원"을 "Selector로 복원"으로, 추천 표시를 "로컬 Selector 배정"으로 바꾸고 `route-options.ts` 안내에 Antigravity를 추가했습니다.
11. **문서**: 구현자는 `README.md`·`OVERVIEW.md`를 범위 밖으로 두었고, 조정자가 리뷰 전에 두 문서의 "사용량 기반 자동 배정" 설명을 로컬 Selector 배정 설명으로 갱신했습니다.
12. **독립 리뷰 반영**(`/tmp/arena-cb/review.md`, 리뷰어 antigravity/gemini-4-neon high, 판정 통합 허락): minor #1 `setupCoordinator`의 `plan-changed`를 사람용 새로 고침 안내로 변환, #2 화면 재조회 플래그 초기화 순서 수정, #3 `confirm` 보류 사유를 기대 경로 자신의 보드 사유로 한정, #4 이 절 정정, #5 `finish-query` 잠금 경합 1회 재시도, nit #6 M 코디네이터 모드 검사를 실행기 자격 검사보다 먼저 수행. nit #7·#8(갱신 중 표시, 계약 시험 조합 보강)은 후속 과제로 남깁니다.
13. **결정 5 철회 — AGY 코디네이터 제외**(2026-11-23, 사용자 지시 "A를 먼저 시도하고 실패하면 B"에 따름)
    - **관찰**: AGY `gemini-4-neon` 코디네이터에서 보드 도구 6개 중 `read_board_conversation`만 동작했습니다. `plan_board_assignment`를 부르자 AGY CLI가 `tool ... is not enabled for server paseo`로 거부했고, Paseo 기본 도구 `list_agents`도 같은 오류로 거부됐습니다.
    - **원인**: AGY CLI는 세션당 도구 선언 예산 안에서 정의가 작은 MCP 도구부터 켭니다. Paseo가 주입한 90개 중 45개(192~551B)만 켜지고, 578B 이상은 lazy 목록에도 오르지 않았습니다. Paseo 도구 정책·플러그인 부착·AGY 사용자 MCP 설정은 원인이 아니었습니다.
    - **시도 A**: `agents.providers.antigravity.paseoTools.disabledTools`에 44개를 넣어 46개로 줄였습니다. 33개(최대 993B, 합계 15,051B)만 켜져서 개수 상한이 아니라 크기 예산임을 확인했습니다. 그래도 `assign_board_worker`(1,525B)·`classify_board_conversation`(1,627B)·`review_board_records`(1,004B)는 꺼진 채였습니다. 설정은 원복했습니다.
    - **조치 B**: `coordinatorModes`에서 `antigravity`를 빼서 M 후보와 코디네이터 생성에서 AGY를 제외하고, `verifyCoordinatorRuntime`과 `route-options.ts` 안내 문구의 AGY 추가분을 되돌렸습니다. 작업자(A~D)의 AGY 배정과 권한 모드 `auto`는 유지합니다.
    - **남은 위험 [미확인]**: AGY 작업자에 붙는 `report_to_board`도 같은 예산에서 빠질 수 있습니다.
