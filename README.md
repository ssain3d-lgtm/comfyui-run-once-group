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
2. Right-click it and open the group picker. Each click toggles a `✔`, and the chosen
   titles collect in the `group_titles` box, one per line. The last entry clears them
   all.
3. Pick `mode_during_run`. It applies to every group you chose.

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
and only the missing title is reported to the console along with the graph's current
group list.

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
   ↑ apply                                                        ↓
   the only point that reaches this prompt          status{queue_remaining:0} → release
```

- **Applying must happen in `beforeQueued`.** `graphToPrompt()` runs immediately
  after, so anything changed later misses this submit entirely.
- **Releasing waits for the queue to empty**, which is why the bypass stays visible
  on the canvas for the whole run.

The release condition is `queue_remaining == 0` rather than a single completion event,
so a `batchCount` of two or more — or several items queued by hand — is not released
the moment the first one finishes.

## Why it is safe to leave modes changed mid-run

`Comfy.Workflow.AutoSave` defaults to `off` and nothing here writes to disk, so a
browser crash or refresh mid-run reopens the saved original.

**One thing to watch: saving by hand (Ctrl+S) during a run saves the temporary state.**
The same applies if you switch AutoSave to `after delay`.

## Failure handling

- If a submit is rejected (validation error, auth failure), `execution_start` never
  arrives. A 2-second net restores everything and warns. Nothing is left bypassed.
- Interrupts and execution errors take the normal release path.
- Leaving the page restores once more.

## Why the frontend and not a backend node

Bypass (`mode: 4`) is a litegraph concept. `graphToPrompt()` resolves it in the
browser, so the backend never learns the node existed. **A Python node cannot change
the bypass state of the execution it belongs to.** `run_once_group.py` therefore only
holds settings: it has no outputs, is not an `OUTPUT_NODE`, and never enters the
execution schedule.

## Verification

`55 pass / 0 fail`, no network required.

Stays bypassed after submit and through the run, restores on finish · stays through
batches and multi-item queues · restores on interrupt · net restores and warns on a
rejected submit · does nothing on a title typo, `enabled=false`, or when the control
node itself is bypassed · `Active` works in reverse · mixed original modes each
restore to their own value · **core partial execution and rgthree group ▶ both do
nothing at apply, during and after, and the very next main Run works normally** ·
an empty `queueNodeIds` counts as a full run · works with rgthree absent · a call
with no arguments counts as a main Run.

Multiple groups: two groups applied and restored together · one bad line still
applies the rest and warns only about that line · whitespace, blank lines and
duplicates cleaned · a node shared by overlapping groups restores to its real
`Mute` value · backward compatibility with the older `group_title` widget name ·
right-click check, add, remove, clear all · **two nodes running as `Bypass` and
`Active` simultaneously without touching each other**.

## Browser cache

Extension JS is cached by the browser. After updating, a restart may not be enough —
**hard-refresh with Ctrl+F5**. You have the current build when the console shows:

```
[Run Once] rgthree group/node queue (N nodes) — leaving this submit alone.
```

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
