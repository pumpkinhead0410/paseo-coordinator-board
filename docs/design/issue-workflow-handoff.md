# 코디네이터 보드 이슈 최초 배정과 통합 결과 회수 설계

## Problem

2026-11-26 EasyDocs 이슈 5건(#301·#303·#305·#307·#308)을 코디네이터 보드로 운영한 실제 기록을 추적한 결과, 두 구간에서 구조적 마찰과 오분류가 재현됐습니다.

1. **구현 확정 이슈의 2단계 중간 인계(#301·#307·#308)** — 04:28 UTC에 코디네이터(`0ef165c7`)가 #308(`495b1162`), #307(`90a354f7`), #303(`89d06229`), #301(`4d7a11b4`)을 모두 EasyDocs 공유 `local_checkout`(`/home/juno/MyCode-WSL/EasyDocs`)에 최초 배정했습니다. 구현이 시작된 04:46–04:47 UTC에 #301·#307·#308 세 건은 작업을 중단하고 인계를 회수해 전용 worktree의 새 구현 세션(`38ff0323`, `7cc542fb`, `cefb9a46`)으로 다시 배정해야 했습니다. 반면 조사 전용 #303(`89d06229`)은 worktree 없이 로컬 체크아웃에서 조사를 마치고 `NOT_PLANNED`로 닫혔고, #305(`4200736f`)는 1단계 통합 뒤 2단계 설계·자료 대기 인계를 기존 로컬 워크스페이스(`wks_e19126085df4088b`)에서 유지했습니다.
   - **코드 근거**: `server/dispatch.ts`의 `readManagedWorkspaces`는 Paseo `workspaces.list()`가 이미 반환하는 `workspaceKind`, `gitRuntime.currentBranch`, `workspaceDirectory`를 버리고 `{ id, projectId, title }`만 반환했습니다. `server/discovery.ts`의 `SessionRow`와 `server/operations.ts`의 `plan_board_assignment`도 세션의 `workspaceId`를 누락해, 코디네이터가 기존 담당자·워크스페이스를 식별하거나 최종 `worktree`와 공유 `local_checkout`을 구분하기 어려웠습니다.
2. **통합 완료 뒤 이전 검증 대기의 잔존(#308) 및 종료 사유·정리 인계 혼재** — 05:51 UTC에 #308 구현 세션(`cefb9a46`)에 `review` 판단(“운영 세션의 실제 통합 결과 최종검증이 남았습니다.”)이 기록됐습니다. 이후 `cf6f661`이 `main`에 통합되고 06:03:16 UTC에 GitHub #308이 닫혔습니다. 06:03:35 UTC에 코디네이터가 `classify_board_conversation`으로 `idle` 갱신을 시도했으나, 대상 세션이 대기 상태가 아니어서 `"대기 중인 관리 세션을 확인해 주세요."`(`isError: true`)를 반환했습니다. 오류 문구가 실행 중·권한 대기·부재를 구분하지 않아 후속 재분류가 누락됐고, 06:37 UTC `/done`과 정리 인계(`handoff-wks_83a9a13cc14f6225.md`) 뒤에도 `scope.json`에는 05:51 UTC의 검증 대기 판단이 그대로 남았습니다. 또한 `read_board_conversation({})` 목록은 각 세션의 기존 `judgment`와 활성 `note`를 보여주지 않아 다이제스트에서 잔존 판단을 즉시 식별하기 어려웠습니다.

기존 제약은 [보드 배정 작업자의 첫 턴 알림](board-worker-finish-notifications.md)과 [코디네이터의 작업자 상태 오보고 원인과 재발 방지 설계](coordinator-worker-status.md)를 그대로 승계합니다. Paseo 0.17.4의 보드 배정 경로는 첫 턴 완료 알림을 구독하지 않으며, 새 MCP 도구나 별도 상태 저장소 없이 기존 도구·헌장·운영 예시·다이제스트 계약을 우선합니다. EasyDocs 사례는 읽기 전용 참조이며 보관·정리·게시·배포는 이 작업 범위 밖입니다.

## Usage (caller's view)

```ts
// 1. 최초 배정 전 계획 조회 — 워크스페이스 종류·브랜치·경로와 세션의 workspaceId 확인
const plan = await plan_board_assignment({});
// plan.workspaces: [{ id: "wks_83a9...", projectId, title, kind: "worktree", branch: "feat/two-col-photo-replace-308", path: ".../easydocs-308" },
//                   { id: "wks_e191...", projectId, title, kind: "local_checkout", branch: "main", path: ".../EasyDocs" }]
// plan.sessions:   [{ id: "cefb9a46...", projectId, workspaceId: "wks_83a9...", workspaceTitle, status: "idle" }]
// → 기존 담당자가 있으면 재사용, 확정된 구현은 최종 worktree로 최초 배정, 조사 전용(#303)은 local_checkout 유지

// 2. 통합·다이제스트 시 잔존 판단·카드 기록 식별과 상태별 실패 처리
const rows = await read_board_conversation({});
// rows[i]: { id, projectId, workspaceId, workspaceTitle, title, status, activityAt,
//            judgment?: { kind: "review", evidenceId: "..." },
//            note?: { kind: "review", origin: "agent" } }

// 실행 중인 세션에 classify_board_conversation을 호출하면 재시도 지침이 포함된 오류를 반환
// → "실행 중인 세션은 분류할 수 없습니다. 대기 상태(idle)로 바뀐 뒤 최신 evidenceId를 다시 읽어 재분류하세요."
// 세션이 idle로 전환된 뒤 최신 발췌를 다시 읽고 검증 영수증·커밋·GitHub 종료 사유·정리 인계를 구분해 분류
const latest = await read_board_conversation({ sessionId: "cefb9a46..." });
await classify_board_conversation({
  sessionId: "cefb9a46...",
  evidenceId: latest.evidenceId,
  kind: "idle",
  text: "#308 cf6f661 원격 main 통합·최종검증·GitHub COMPLETED 확인. workspace 정리 인계는 별도 보존·사용 종료 대기.",
});
```

## Shape

기존 4개 코디네이터 도구(`plan_board_assignment`, `assign_board_worker`, `read_board_conversation`, `classify_board_conversation`)와 `SessionRow`·`WorkspaceChoice`의 좁은 공개 표면을 유지하면서 누락된 관측 정보와 실패 진단만 보강합니다.

| 모듈 | 변경 범위 | 소유하는 불변식 |
|---|---|---|
| `shared/contract.ts`, `server/discovery.ts` | `SessionRow`에 선택적 `workspaceId?: string` 추가 | 세션↔워크스페이스 매핑의 단일 원본(중복 조회 없음) |
| `shared/dispatch.ts`, `server/dispatch.ts` | `WorkspaceChoice`와 `readManagedWorkspaces`에 `kind?`·`branch?`·`path?` 추가 | Paseo `workspaces.list()`의 워크스페이스 격리 유형과 브랜치를 손실 없이 노출 |
| `server/operations.ts` | `plan_board_assignment` 세션 행에 `workspaceId` 포함, `plan`·`assign` 설명 갱신 | 최종 worktree 최초 배정·조사 전용 유지·기존 담당자 재사용 안내 |
| `server/coordinator.ts`, `index.server.ts` | `read_board_conversation({})`에 `workspaceId`·`workspaceTitle`·`judgment?`·`note?` 포함, `classify_board_conversation`의 비대기 거절 사유 세분화(`부재`·`권한 대기`·`실행 중`·`기타 비대기`) 및 설명 갱신 | 최신 `evidenceId` 없이 분류 불가(fail-closed), 잔존 판단 즉시 가시화, 실행 중 거절 시 재조회 경로 명시 |
| `server/lifecycle.ts`, `server/digest.ts`, `templates/coordinator-session.md` | 헌장·다이제스트 프롬프트·기존 세션 운영 예시 동기화 | 완료 영수증 없는 완료 판정 금지, 통합 결과 vs 정리 인계 분리, `NOT_PLANNED`(#303)와 단계 진행 중 결정 대기(#305) 구분 |

인터페이스 깊이 평가: 새 도구·새 RPC·새 영속 저장소를 추가하지 않으므로 AGY 도구 예산과 업스트림 병합 부담이 늘지 않으며, 호출자는 추가 셸 호출 없이 기존 보드 조회 응답만으로 워크스페이스 유형·기존 담당자·잔존 판단을 판별할 수 있습니다.

## Synthesis decision

- **채택안(Base)**: **기존 도구 표면 관측성 보강 + 운영 계약 동기화(Shape 1)**. 단일 상태 원본(`scope.json`·`notes.json`)을 유지하고, 기존 보드 도구 4개와 템플릿·헌장·다이제스트의 좁은 수정으로 두 문제를 직접 해소합니다.
- **이식한 요소(Graft from Shape 2)**: 구조화 원장 후보(Shape 2)에서 가져온 두 가지 불변식 — (1) `classify_board_conversation`의 상태별 명시적 오류 구분(`running` vs `permission` vs `closed`/부재), (2) `read_board_conversation({})`에서 기존 `judgment`·`note`를 노출해 잔존 검증 대기를 기계적으로 탐지할 수 있게 한 점 — 을 새 저장소 없이 기존 도구에 통합했습니다.
- **기각한 요소**: 새 MCP 도구(`record_issue_outcome`), `scope.json` 내 별도 이슈 원장, `assign_board_worker`의 `local_checkout` 강제 차단. 이유: 상태 이중화(split ownership), 동일 목적 도구 중복, 비-Git·조사·로컬 합의 작업의 오차단, 그리고 사람 제품 결정 선행 필요.

## Tradeoffs accepted

- `read_board_conversation({})`의 `judgment`·`note` 노출은 타임라인을 추가 조회하지 않으므로 `judgment.evidenceId`의 최신 일치 여부(`stale` bool)는 세션 발췌 조회 시 대조합니다. 목록 조회 비용 증가 없이 잔존 판단을 식별하는 대신 상세 확인은 기존 `{ sessionId }` 조회를 유지합니다.
- `assign_board_worker`는 `local_checkout`을 강제 거절하지 않고 `plan_board_assignment`의 `kind`·`branch`·`path` 노출과 헌장·도구 설명으로 안내합니다. 조사 전용(#303)과 2단계 인계(#305), 비-Git 프로젝트의 정상 경로를 깨지 않기 위함입니다.
- 작업자가 `report_to_board`로 남긴 `origin: "agent"` 카드 기록(`notes.json`)은 `classify_board_conversation`이 덮어쓰거나 지우지 않습니다. 현재 `shared/decision-count.ts`의 우선순위를 임의로 바꾸면 제품 계약 변경이 되므로 아래 제품 결정 항목으로 분리했습니다.

## Alternatives considered

- **별도 이슈 원장 + 전용 도구(`record_issue_outcome`) + `workMode` 강제 차단**: 이슈 단위 통합 커밋·검증·종료 사유·정리 상태를 보드 내부에 구조화해 강제할 수 있으나, 기존 `judgments`·`notes`·`tracked-decisions`와 소유권이 갈라지고(split ownership), 새 MCP 도구 추가로 도구 예산과 업스트림 충돌이 커지며, 제품 결정 없이 강제 정책을 도입하게 되어 기각했습니다.
- **문서·헌장 문구만 수정(코드 변경 0)**: 구현 변경은 가장 작으나, `plan_board_assignment`가 `workspaceKind`·`branch`·`workspaceId`를 숨기고 `read_board_conversation({})`가 기존 `judgment`·`note`를 숨기며 `classify_board_conversation`이 실행 중 오류 원인을 감추는 구조적 관찰 결함이 그대로 남아 기각했습니다.

## Acceptance criteria

1. **확정 구현 최초 배정과 예외 보존(#301·#307·#308 vs #303·#305)**: `plan_board_assignment`가 `workspaces[].kind`·`branch`·`path`와 `sessions[].workspaceId`를 반환해 최종 `worktree`, 공유 `local_checkout`, 기존 담당자 세션을 구분할 수 있어야 합니다.
2. **#308 잔존 판단 재현·해소**: 이전 `review`/`question` 판단이 남은 상태에서 대상 세션이 `running`이면 `classify_board_conversation`이 실행 중 사유와 재분류 안내로 거절(fail-closed)하고, `idle` 전환 뒤 최신 `evidenceId`로 재분류하면 통합 결과와 정리 인계가 구분된 최신 `idle` 판단으로 교체돼야 합니다. 옛 `evidenceId` 재사용은 계속 거절돼야 합니다.
3. **완료 영수증 없는 완료 판정 금지**: 검증 영수증·통합 커밋·GitHub 종료 사유가 없는 상태나 빈 발췌에서는 완료로 닫지 않아야 합니다.
4. **사유별 구분(#303 `NOT_PLANNED` · #305 단계 진행)**: #303의 조사 중단(`NOT_PLANNED`)과 #305의 1단계 완료 + 2단계 사용자 결정 대기(`question` + `needsInput`)가 각각 정확한 분류와 근거로 표현돼야 합니다.
5. **표면 동기화**: 새 헌장(`server/lifecycle.ts`), 기존 세션 운영 예시(`templates/coordinator-session.md`), 다이제스트 프롬프트(`server/digest.ts`), 도구 설명(`server/operations.ts`, `server/coordinator.ts`)이 동일한 계약을 일관되게 안내해야 합니다.

## Open product decisions (사람 판단 필요)

1. **PD-1 · 작업자 `report_to_board`(`origin: "agent"`) 카드 기록의 통합 후 해소 방식**
   - **현행 동작**: 작업자가 `report_to_board({ kind: "question" | "review" })`로 남긴 기록은 `notes.json`에 `evidenceId` 없이 저장됩니다. `shared/decision-count.ts:15-17`과 `server/decisions.ts:37-39`에서 이 기록은 코디네이터의 `classify_board_conversation({ kind: "idle" })`보다 우선하므로, 작업자가 이전 단계에서 올린 `agent-note`가 있으면 세션 보관 전까지 카드가 `human` 또는 `review`에 남습니다(`person-note`는 사람이 직접 관리하는 것이 기존 계약).
   - **후보 A(추천)**: `report_to_board` 저장 시점의 `evidenceId`를 함께 기록하고, 새 턴의 근거에서 코디네이터가 `idle`로 분류하면 이전 `evidenceId`의 `origin: "agent"` 기록만 비활성화(사람 기록 `origin: "person"`은 불변). 장점: #308처럼 이전 단계 보고가 통합 후에도 남는 문제를 구조적으로 제거. 단점: `notes.ts`·`reporting.ts`·`decisions.ts`·`decision-count.ts` 4개 파일과 기존 노트 스키마 확장 필요.
   - **후보 B**: 현행 유지 — `read_board_conversation({})`의 `note` 표시로 코디네이터가 잔존 `agent-note`를 인지하고, 완료된 작업 세션 보관 또는 작업자 `/done` 보고 갱신으로 해소. 장점: 보드 판정 규칙 변경 0. 단점: 작업자가 `question` 노트를 남긴 채 세션이 남아 있으면 사람이 직접 정리해야 함.
2. **PD-2 · `assign_board_worker`의 `local_checkout` 구현 배정 경고/차단 여부**
   - **후보 A(추천)**: 현행 유지(관측 정보 `kind`·`branch`·`path` + 헌장·도구 설명 안내). 장점: 조사 전용(#303), 2단계 인계(#305), 비-Git 프로젝트, 사용자 합의 로컬 작업을 오차단하지 않음. 단점: 모델의 지침 준수에 의존.
   - **후보 B**: `assign_board_worker` 입력에 선택적 `intent?: "implement" | "investigate"`를 추가해 `"implement"`일 때 `local_checkout`이면 경고 또는 거절. 장점: 기계적 차단. 단점: 입력 스키마 확장 및 예외 케이스(비-Git·단일 체크아웃) 분기 부담.
3. **PD-3 · 보드 배정 작업자의 첫 턴 완료 알림 채택 여부**
   - 기존 [board-worker-finish-notifications.md](board-worker-finish-notifications.md)의 사람 결정 항목과 동일합니다. Paseo 업스트림 지원(후보 E) 전까지 F(조회)+G(명시적 보고)를 유지할지, 플러그인 훅(후보 D)에 단기 비용을 쓸지 결정이 필요합니다.
4. **PD-4 · 통합 담당자 ≠ 원 작업 세션일 때 이슈 단위 추적 방식**
   - **후보 A(추천)**: 현행 세션 단위 모델 유지 — 통합 담당자가 통합 후 원 작업 세션의 `classify_board_conversation`을 최신 `evidenceId`로 갱신. 장점: 기존 보드 데이터 모델과 호환, 추가 저장소 없음. 단점: 원 작업 세션이 실행 중이면 `idle` 전환 후 재분류가 필요.
   - **후보 B**: 프로젝트별 `tracked-decisions.json` / `tracked-sources.json` 원장을 EasyDocs 운영에 도입해 이슈 단위 카드로 추적. 장점: 다중 세션이 관여하는 이슈를 카드 하나로 묶음. 단점: 프로젝트별 원장 생성·갱신 자동화 유지 비용 추가.
