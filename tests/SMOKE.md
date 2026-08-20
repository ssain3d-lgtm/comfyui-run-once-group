# What the automated tests cannot tell you

`tests/run.mjs` runs the shipped extension file against **test doubles** of ComfyUI's `app` and
`api`. That catches every logic regression, and it catches nothing at all about ComfyUI changing
underneath us — if `queue_remaining` stopped counting running prompts tomorrow, the suite would
still be green and the extension would still be broken.

So the doubles encode assumptions, and those assumptions are the part that needs a human.

## Assumed contracts

| # | Contract | Last checked |
|---|---|---|
| 1 | `LGraphNode.serialize()` fills `o.mode` from the live node, **then** calls `onSerialize(o)`, which may rewrite it | 2026-08-13, [litegraph.js `src/LGraphNode.ts`](https://github.com/Comfy-Org/litegraph.js) |
| 2 | `app.graphToPrompt()` builds the embedded workflow with `graph.serialize()`, and skips bypassed nodes by reading live `node.mode` | 2026-08-13, [ComfyUI_frontend `src/utils/executionUtil.ts`](https://github.com/Comfy-Org/ComfyUI_frontend) |
| 3 | `widget.beforeQueued(options)` is called on every widget of every node, immediately before `graphToPrompt()`, with `{ isPartialExecution }` | inherited, unverified |
| 4 | `api.queuePrompt(number, prompt)` resolves `{ prompt_id, number, node_errors }` and throws when the server refuses | inherited, unverified |
| 5 | The `status` event carries `exec_info.queue_remaining`, counting queued **and** running prompts | inherited, unverified |
| 6 | `execution_start` / `_success` / `_error` / `_interrupted` all carry `prompt_id` | inherited, unverified |
| 7 | rgthree stashes ids on `globalThis.rgthree.queueNodeIds` for the duration of its submit | inherited, unverified |
| 8 | `LGraphGroup` has a stable numeric `id`, included in `serialize()` and restored by `configure()` | 2026-08-20, [litegraph.js `src/LGraphGroup.ts`](https://github.com/Comfy-Org/litegraph.js) |

Contracts 1 and 2 are the ones the mid-run save fix rests on. Break either and saving during a run
silently goes back to capturing the temporary state — nothing throws.

## After a ComfyUI or frontend update

Ten minutes in the real app. Put a slow group in the graph so there is time to look around.

1. **Basic hold and release** — pick a group, press Run. The badge reads `holding N`, the group is
   visibly bypassed, and both revert when the queue empties.
2. **The bug this all started with** — queue a long job, then press Run again while it is still
   going. The second run must stay bypassed the whole time it waits. Two seconds in is when the
   old build broke.
3. **Mid-run save** — press Run, then Ctrl+S while it is still running. Reload the workflow: the
   group must come back in its original mode, not bypassed.
4. **Provenance** — drag a PNG produced by a run back into ComfyUI. The bypassed group should load
   bypassed, with the Run Once node present and its titles intact.
5. **Rejected submit** — disconnect a required input and press Run. ComfyUI shows its error, and
   everything restores about half a second later. Nothing stays bypassed.
6. **Clear Queue** — queue a batch of 3, clear the queue mid-way. Modes come back within ~1.5s.
7. **Scoped runs** — press ▶ on a group header (rgthree) and "Queue Selected Output Nodes". Both
   must leave the modes completely alone, and a normal Run right after must still work.
8. **Rename following** — pick a group via the picker, rename the group, run. The run must still
   hold it, and the line in `group_titles` must rewrite itself to the new title. Delete a targeted
   group instead: the badge drops to `N/M groups` and the picker shows the title with an ✖.
9. **Per-group modes** — target two groups, give one `= Active` via the ticked row's submenu.
   One run must bypass the plain one and activate the other, and both must restore.

If any of these fail, the contract table above is the place to start, and a failing case belongs in
`tests/run.mjs` before it is fixed.
