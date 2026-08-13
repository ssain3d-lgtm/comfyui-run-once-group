# ComfyUI Run Once Group Toggle

Bypass a group for one queue submit, then put it back.

Add the node, tick the groups you want, press Run. Those groups are bypassed for that
submit only, and when the queue empties every node returns to the mode it actually
had — not to a guessed default.

Useful when part of a graph is expensive and you only want it sometimes, without
hunting down every node and pressing Ctrl+B twice.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/ssain3d-lgtm/comfyui-run-once-group
```

Restart ComfyUI, then hard-refresh the browser (Ctrl+F5). No dependencies, and
nothing is written to disk.

## Use

1. Add **Run Once Group Toggle** anywhere on the canvas.
2. Press **Pick groups** on the node (or right-click it — same menu). Each click toggles
   a `✔`, and the chosen titles collect in the `group_titles` box, one per line. The last
   entry clears them all.
3. Pick `mode_during_run`. It applies to every group you chose.

The badge in the node's title bar says what will happen, so you never have to open the
console to find out:

| Badge | Meaning |
|---|---|
| `3 groups` | three chosen, all three found |
| `1/2 groups` | one title matches nothing — renamed group, or a typo |
| `holding 12` | a run is in flight and 12 nodes are switched right now |
| `no groups` / `off` | nothing chosen, or `enabled` is off |

A title that matches nothing also gets its own `✖ … (not in this graph)` row in the
picker, so a group renamed out from under your list is visible and one click removes it.

| Mode | While running | After |
|---|---|---|
| `Bypass` (default) | the group is skipped | restored |
| `Active` | a normally-off group runs | restored |
| `Mute` | fully off | restored |

Turning `enabled` off makes the node do nothing.

### Writing titles

**Newline is the only separator.** Commas are not, because titles routinely contain
punctuation — `D. Upscale · Interpolate (all bypassed)` would be shredded by a comma
split and match nothing. Leading and trailing spaces, blank lines and duplicates are
cleaned up for you.

A typo on one line does not stop the rest: the groups that matched are still applied,
and only the missing title is called out — on the badge before the run, as a toast at
the moment it costs you work, and in the console with the graph's current group list.

**Overlapping groups are safe.** If one node belongs to two groups you selected, the
first claim records its original mode and it is restored exactly once.

### Different modes at once

Put down a second node. `tracked` and `cycle` are module-level, so instances
cooperate: one can bypass group A while another activates group B in the same submit,
and everything is restored together at the end.

Toggles never target each other. `beforeQueued` fires per node in graph order, and
bypassing a toggle whose turn has not come would trip its own `ctrl.mode === Bypass`
guard and silently do nothing — a bug that appears or disappears depending on graph
order. Nodes of this type are therefore excluded from switching.

## Only the blue Run button

A group header **▶**, "Queue Selected Output Nodes" and rgthree's "Queue Node" are all
left alone. Bypassing the very group you asked to run would leave nothing to execute.

The catch is that there are two scoped-run mechanisms and they look nothing alike:

| Path | Call | Detected by |
|---|---|---|
| Main Run | `queuePrompt(number, batchCount)` | `isPartialExecution: false` → **applies** |
| Core "Queue Selected Output Nodes" | `queuePrompt(0, batchCount, queueNodeIds)` | `isPartialExecution: true` → skipped |
| **rgthree group ▶ / Queue Node** | **`queuePrompt(0)`** — no third argument | `isPartialExecution: **false**` ← the trap |

rgthree does not use the core partial-execution path at all. It stashes node ids in
`rgthree.queueNodeIds`, calls `app.queuePrompt(0)` with no scope argument, and only
much later trims `prompt.output` inside its `api.queuePrompt` wrapper. The frontend
never learns it was a scoped run, so checking `isPartialExecution` alone lets a
group ▶ straight through.

Both signals are therefore checked:

```js
if (options?.isPartialExecution) return;                 // core
if (globalThis.rgthree?.queueNodeIds?.length) return;    // rgthree (cleared in finally)
```

Where rgthree is not installed this is simply `undefined` and has no effect.

## Applying and releasing happen at different moments

```
beforeQueued   → graphToPrompt()  →  POST  →  execution_start … execution_success
   ↑ apply                          ↓ accepted?                     ↓
   the only point that reaches      prompt_id      status{queue_remaining:0} → release
   this prompt
```

- **Applying must happen in `beforeQueued`.** `graphToPrompt()` runs immediately
  after, so anything changed later misses this submit entirely.
- **Releasing waits for the queue to empty**, which is why the bypass stays visible
  on the canvas for the whole run.

The release condition is `queue_remaining == 0` rather than a single completion event,
so a `batchCount` of two or more — or several items queued by hand — is not released
the moment the first one finishes.

### "Accepted" is not "started"

These are separate questions and they must not share an answer:

| Question | Answered by | How long it takes |
|---|---|---|
| Did the server **take** the submit? | the `POST /prompt` result | milliseconds |
| Has the submit **started running**? | `execution_start` | as long as the queue ahead of it |

Press Run while another job is already going and your prompt is accepted at once but does
not start for minutes. An earlier build read `execution_start` as the acceptance signal
and gave it two seconds, so **every run queued behind another job was torn down two
seconds in** — the modes snapped back on the canvas and the console claimed the submit
had been rejected. The prompt itself was fine, because `graphToPrompt()` had already run,
but the graph was lying to you for the rest of the run.

Acceptance now comes from the POST result, which `api.queuePrompt` resolves with a
`prompt_id` or throws on, regardless of queue depth. Outstanding `prompt_id`s are then
tracked individually, so release needs both an empty server queue and no results still
owed.

## Why it is safe to leave modes changed mid-run

`Comfy.Workflow.AutoSave` defaults to `off` and nothing here writes to disk, so a
browser crash or refresh mid-run reopens the saved original.

**One thing to watch: saving by hand (Ctrl+S) during a run saves the temporary state.**
The same applies if you switch AutoSave to `after delay`.

## Failure handling

Nothing is ever left bypassed, and nothing is released while a run of yours is alive.

| Situation | What happens |
|---|---|
| Submit rejected — validation error, auth failure, server down | The POST throws, nothing is queued, everything restores ~0.5 s later |
| `200` that still carries `node_errors` | Counted as rejected, same path |
| Interrupt, or an execution error | The normal release path |
| **Queue cleared while your prompts are pending** | Those prompts never report a result. After 1.5 s of a confirmed-empty queue the ids are treated as dead and the modes come back |
| Another extension replaced `api.queuePrompt` without chaining | The POST result never reaches us, but a queue that grew still proves the run is real, so it is held rather than torn down |
| Leaving the page | Restores once more |

The half-second before declaring a submit rejected is waiting on the queue-change
broadcast, which the server sends as it puts the prompt on the queue — before it even
answers the POST. That is a wait measured in milliseconds, unlike the `execution_start`
it replaced.

## Why the frontend and not a backend node

Bypass (`mode: 4`) is a litegraph concept. `graphToPrompt()` resolves it in the
browser, so the backend never learns the node existed. **A Python node cannot change
the bypass state of the execution it belongs to.** `run_once_group.py` therefore only
holds settings: it has no outputs, is not an `OUTPUT_NODE`, and never enters the
execution schedule.

## Verification

```
node tests/run.mjs        →  23 pass / 0 fail
```

No dependencies, no network, no ComfyUI. The tests load `web/js/run_once_group.js`
exactly as shipped: its `../../scripts/app.js` import resolves to the test doubles in
`scripts/`, which is the only reason that directory exists at the repository root.
ComfyUI serves `WEB_DIRECTORY` (`./web/js`) and nothing else, so it never sees it.

**Release timing** — an accepted submit survives well past the old two-second net while
queued behind another job · a rejected submit restores without needing an
`execution_start` that will never come · a `200` carrying `node_errors` counts as
rejected · a stale `status{0}` landing right after acceptance does not release · a
cleared queue is swept after its grace period · a resubmit inside the sweep window voids
the stale sweep · a batch of two releases once, at the end
· interrupt takes the normal path · a POST result that never reaches us is inferred from
a growing queue.

**Scope and correctness** — core partial execution and rgthree's group ▶ both do nothing,
and the very next main Run works normally · one bad title still applies the rest and says
which · a node shared by overlapping groups restores to its real `Mute` value · two nodes
run `Bypass` and `Active` at once without touching each other · `enabled=false` does
nothing · whitespace, blank lines and duplicates are cleaned · the older `group_title`
widget name still works.

**UI** — the picker ticks chosen groups, flags titles matching nothing and removes them
on click · the button is appended last and does not serialize, so `widgets_values` keeps
the layout saved workflows were written against · a node saved before the button existed
is grown to fit it and never shrunk · the badge reports counts, shortfalls, the held
count during a run, and `off`.

## Browser cache

Extension JS is cached by the browser. After updating, a restart may not be enough —
**hard-refresh with Ctrl+F5**. You have the current build when the node shows a
**Pick groups** button and a badge in its title bar; neither existed before.

## Limits

- Root-level groups only. **Groups inside a subgraph are not targets.**
- A litegraph group owns the nodes inside its rectangle, so moving a node across the
  boundary changes what is affected. `recomputeInsideNodes()` is called each time to
  judge from the current layout.

## Compatibility note

The class name is `RunOnceGroupMode` and will not change — workflows store it as the
node's key, so renaming it would orphan every saved instance. Only the display name
is cosmetic.

## License

MIT. Independent work with no third-party code.
