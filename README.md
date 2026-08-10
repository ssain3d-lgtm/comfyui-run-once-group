# ComfyUI Run Once Group Toggle

Bypass a group for one queue submit, then put it back.

Add the node, tick the groups you want, press Run. Those groups are bypassed for
that submit only and return to their previous mode when the queue empties — each
node to whatever it was, not to a guessed default.

Useful when part of a graph is expensive and you only want it some of the time,
without hunting for every node and pressing Ctrl+B twice.

| Mode | While running | After |
|---|---|---|
| `Bypass` (default) | the group is skipped | restored |
| `Active` | a normally-off group runs | restored |
| `Mute` | fully off | restored |

- **Several groups per node.** Right-click to tick them off a list; one per line.
- **Several nodes.** Two toggles can run in the same submit with different modes.
  They never touch each other.
- **Only the blue Run button.** A group header ▶, "Queue Selected Output Nodes",
  and rgthree's "Queue Node" are all left alone — bypassing the very group you
  asked to run would leave nothing to execute.
- **Fails safe.** If the submit is rejected, a 2-second net restores everything
  and warns. Interrupts and errors restore too. Nothing is left bypassed.

No dependencies. Nothing is written to disk.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/ssain3d-lgtm/comfyui-run-once-group
```

Restart ComfyUI, then hard-refresh the browser (Ctrl+F5).

## Limits

Root-level groups only — groups inside a subgraph are not targets.

## License

MIT. Independent work with no third-party code.

---

아래는 한국어 설명입니다.

Run 을 누르면 지정한 그룹들이 **바이패스되고**, **실행이 끝나면 바이패스가 풀립니다.**
각 노드는 전환 전 자기 모드로 돌아갑니다. **그룹은 여러 개 고를 수 있습니다.**

## 쓰는 법

1. 아무 데나 `그룹 1회 전환 (Run Once)` 노드를 추가합니다.
2. 노드를 **우클릭 → 그룹 고르기** 에서 대상 그룹을 고릅니다. 클릭할 때마다 체크(`✔`)가
   토글되고, 고른 것들이 `group_titles` 칸에 한 줄씩 쌓입니다. 맨 아래 `— 모두 해제` 로
   전부 비웁니다.
3. `mode_during_run` 을 고릅니다. **고른 모든 그룹에 똑같이 적용됩니다.**

| 값 | 실행 동안 | 실행 후 |
|---|---|---|
| `Bypass` (기본) | 그룹을 건너뜀 | 원래 모드로 복귀 |
| `Active` | 평소 꺼둔 그룹을 돌림 | 원래 모드로 복귀 |
| `Mute` | 완전히 끔 | 원래 모드로 복귀 |

`enabled` 를 끄면 이 노드는 아무 것도 하지 않습니다.

### 그룹마다 다른 모드가 필요하면 노드를 하나 더 놓으세요

`tracked` 와 `cycle` 이 모듈 전역이라 인스턴스끼리 협조합니다. A-2 는 끄고 D 는 켜는 식으로
서로 다른 모드를 한 번의 Run 에서 같이 쓸 수 있고, 복원은 마지막에 한꺼번에 일어납니다.

Run Once 노드는 **서로를 건드리지 않습니다.** `beforeQueued` 는 그래프 순서대로 노드마다
불리는데, 아직 차례가 안 온 컨트롤 노드를 바이패스해 버리면 그 노드가 자기 `ctrl.mode ===
Bypass` 가드에 걸려 조용히 아무 것도 안 하게 됩니다. 순서에 따라 되다 말다 하는 버그라
같은 타입 노드는 전환 대상에서 제외합니다.

### 제목 적는 규칙

**구분자는 줄바꿈뿐입니다.** 쉼표는 쓰지 않습니다 — `D. 업스케일 · 보간 (전부 바이패스)`
처럼 제목 자체에 구두점이 들어가기 때문에, 쉼표로 나누면 제목이 쪼개져 아무 것도 안 잡힙니다.
앞뒤 공백·빈 줄·중복 줄은 알아서 정리합니다.

한 줄이 오타여도 **나머지 그룹은 정상 적용**되고, 못 찾은 제목만 콘솔에 현재 그룹 목록과
함께 경고로 남습니다.

`A. 입력` 과 `A-2. ④ 프롬프트 · LLM` 처럼 **겹치는 그룹을 같이 골라도 안전합니다.** 한 노드는
먼저 잡은 쪽이 원래 모드를 기록하고 한 번만 복원됩니다.

### 위젯 이름이 바뀌었지만 기존 워크플로우는 그대로 열립니다

`group_title`(한 줄) → `group_titles`(여러 줄) 로 바뀌었습니다. `widgets_values` 는 **위치로**
복원되고 슬롯 순서(`enabled`, `group_titles`, `mode_during_run`)를 유지했으므로, 예전에 저장한
`[true, "A-2. ④ 프롬프트 · LLM", "Bypass"]` 는 한 줄짜리 목록으로 그대로 로드됩니다.

## 상단의 파란 Run 에만 반응합니다

그룹 헤더의 **▶** 나 선택 영역 실행, rgthree 의 "Queue Node" 메뉴에는 **반응하지 않습니다.**
대상 그룹의 ▶ 를 눌렀는데 그 그룹을 바이패스해 버리면 실행할 게 남지 않으니까요.

문제는 **범위 실행 방식이 두 가지고, 서로 완전히 다르게 생겼다**는 점입니다.

| 경로 | 호출 | 판별 |
|---|---|---|
| 메인 Run | `queuePrompt(number, batchCount)` | `isPartialExecution: false` → **적용** |
| 코어 "Queue Selected Output Nodes" | `queuePrompt(0, batchCount, queueNodeIds)` | `isPartialExecution: true` → 무시 |
| **rgthree 그룹 헤더 ▶ / Queue Node** | **`queuePrompt(0)`** — 인자 없음 | `isPartialExecution: **false**` ← 함정 |

rgthree(`rgthree.js` `queueOutputNodes`)는 코어의 부분 실행 경로를 **아예 쓰지 않습니다.** 노드 id
를 `rgthree.queueNodeIds` 에 담아두고 3번째 인자 없이 `app.queuePrompt(0)` 을 부른 뒤, 한참 뒤
`api.queuePrompt` 래퍼에서 `prompt.output` 을 잘라냅니다. 프론트엔드는 끝까지 범위 실행인 줄
모릅니다 — `isPartialExecution` 만 보면 rgthree 그룹 ▶ 이 그대로 통과합니다.

그래서 **두 신호를 모두** 봅니다.

```js
if (options?.isPartialExecution) return;                 // 코어
if (globalThis.rgthree?.queueNodeIds?.length) return;    // rgthree (finally 로 즉시 비워짐)
```

rgthree 가 없는 환경에서도 그냥 `undefined` 라 아무 영향 없습니다.

## 적용 시점과 해제 시점이 다릅니다

```
beforeQueued   → graphToPrompt()  →  POST  →  execution_start … execution_success
   ↑ 적용                                                          ↓
   여기서만 프롬프트에 반영됨                          status{queue_remaining:0} → 해제
```

- **적용은 `beforeQueued`** 에서만 가능합니다. 바로 다음이 `graphToPrompt()` 라서, 그 뒤에
  바꾸면 이번 실행에 반영되지 않습니다.
- **해제는 큐가 다 빈 뒤**입니다. 그래서 실행 내내 캔버스에 바이패스 상태가 그대로 보입니다.

해제 조건을 단일 완료 이벤트가 아니라 `queue_remaining == 0` 으로 잡은 이유는, `batchCount` 가
2 이상이거나 여러 건을 큐에 넣었을 때 **첫 번째가 끝나자마자 풀려버리지 않게** 하기 위해서입니다.

## 실행 중에 모드를 바꿔둬도 안전한 이유

`Comfy.Workflow.AutoSave` 의 기본값이 `off` 이고 이 설치본에는 오버라이드가 없습니다
(`user/default/comfy.settings.json` 확인). 스스로 디스크에 쓰는 것이 없으므로, 실행 도중
브라우저가 죽거나 새로고침해도 저장된 원본이 다시 열립니다.

**주의할 것은 하나뿐입니다 — 실행 중에 손으로 저장(Ctrl+S)하면 임시 상태가 저장됩니다.**
(자동저장을 `after delay` 로 켜실 거라면 같은 문제가 생기니 그때 알려주세요.)

## 예외 처리

- 제출이 거부되면(검증 오류·인증 실패 등) `execution_start` 자체가 오지 않습니다. 이 경우
  2초 뒤 안전망이 복원하고 경고를 남깁니다. 바이패스된 채 방치되지 않습니다.
- 중단(interrupt)·실행 오류도 정상 해제 경로를 탑니다.
- 페이지를 떠날 때도 한 번 복원합니다.

## 왜 백엔드 노드가 아니라 프론트엔드인가

bypass(`mode: 4`)는 litegraph 개념입니다. `graphToPrompt()` 가 프론트에서 해소해버리므로
백엔드는 그 노드가 있었다는 사실조차 모릅니다. **파이썬 노드는 자기가 속한 실행의 bypass 를
바꿀 수 없습니다.** 그래서 `run_once_group.py` 는 설정만 들고 있고, 출력도 없고
`OUTPUT_NODE` 도 아니라 실행 스케줄에 아예 안 올라갑니다.

## 검증

`55 pass / 0 fail`

제출 후·실행 중 계속 바이패스 유지 → 종료 시 복원 / 배치·다건에서 마지막 완료까지 유지 /
중단 시 복원 / 제출 거부 시 안전망 복원 + 경고 / 제목 오타·`enabled=false`·컨트롤 노드 자신이
Bypass 일 때 무동작 / `Active` 반대 방향 / 원래 모드가 섞여 있어도 각자 값으로 복원 /
**코어 부분 실행과 rgthree 그룹 ▶ 모두 적용·실행·종료 전 구간에서 무동작이고, 그 직후 메인
Run 은 정상 동작** / `queueNodeIds` 가 빈 배열이면 전체 실행으로 간주 / rgthree 미설치 환경 /
인자 없이 호출돼도 메인 Run 으로 간주.

다중 그룹: 두 그룹 동시 적용·복원 / 한 줄만 오타여도 나머지 적용 + 그 줄만 경고 / 공백·빈 줄·
중복 줄 정리 / 겹치는 그룹에서 공유 노드가 `Mute` 원래값으로 정확히 복원 / 구버전 `group_title`
위젯 이름 하위호환 / 우클릭 체크 토글·추가·제거·모두 해제 / **노드 두 개가 각각 Bypass 와
Active 로 동시에 동작하고 서로를 안 건드림**.

## 브라우저 캐시

확장 JS 는 브라우저가 캐시합니다. 이 파일을 고친 뒤에는 ComfyUI 재시작만으로는 부족할 수
있으니 **Ctrl+F5 (강력 새로고침)** 하세요. 콘솔에 아래가 찍히면 최신본입니다.

```
[Run Once] rgthree 그룹/노드 큐 (노드 N개) — 이번 제출은 건드리지 않습니다.
```

## 한계

- 루트 그래프의 그룹만 봅니다. **서브그래프 안의 그룹은 대상이 아닙니다.**
- litegraph 그룹은 사각형 안에 든 노드를 소유합니다. 경계에 걸친 노드를 옮기면 대상이
  바뀌므로 매번 `recomputeInsideNodes()` 로 최신 판정합니다.
