/**
 * Run-Once group toggle.
 *
 * Press Run -> the target groups go to Bypass. The run finishes -> the bypass is lifted and every
 * node returns to the mode it had before. One node can drive several groups; they all share the
 * one mode_during_run. Two groups needing different modes is two nodes -- `tracked` and `cycle`
 * are module-level, so instances cooperate and release together.
 *
 * Apply and release are deliberately on different clocks:
 *
 *   apply    beforeQueued, because graphToPrompt() runs immediately after it and that is the only
 *            moment the mode can still affect what gets sent.
 *   release  when the queue has drained, because that is when "the run ended" -- not when the POST
 *            returned. The group therefore stays visibly bypassed for the whole run.
 *
 * Holding the modified state for the length of a run is only safe because Comfy.Workflow.AutoSave
 * defaults to "off" and is not overridden here: nothing writes the graph to disk on its own, so a
 * crash or reload mid-run just reloads the clean saved copy. Saving by hand (Ctrl+S) during a run
 * would capture the temporary state -- that is the one thing to avoid.
 *
 * Restore is driven off queue_remaining rather than a single completion event so that batchCount>1
 * and several queued prompts all release once, at the end, instead of after the first one.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "sain3.RunOnceGroupMode";
const NODE_TYPE = "RunOnceGroupMode";
const TAG = "[Run Once]";

// LiteGraph node modes. 0 ALWAYS, 2 NEVER (Mute), 4 BYPASS.
const MODES = { Active: 0, Mute: 2, Bypass: 4 };
const MODE_NAME = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));

/** node -> mode it had before this cycle. Survives the whole run, across batch items. */
const tracked = new Map();

const cycle = {
    active: false,      // something is applied and not yet released
    sawStart: false,    // an execution_start arrived for this cycle
    running: false,     // between execution_start and its completion event
    remaining: null,    // last queue_remaining reported by the server
};

/**
 * Is this submit scoped to part of the graph rather than a full Run?
 *
 * Two mechanisms, and they look nothing alike:
 *
 *  - Core ComfyUI ("Queue Selected Output Nodes") calls queuePrompt(0, batchCount, queueNodeIds),
 *    and the submit loop reports it as `isPartialExecution` via `d = !!queueNodeIds?.length`.
 *
 *  - rgthree's group header ▶ and its "Queue Node" menu do NOT use that path at all. They stash
 *    the ids on `rgthree.queueNodeIds`, call `app.queuePrompt(0)` with no third argument -- so
 *    isPartialExecution is false -- and prune `prompt.output` later, down in the api.queuePrompt
 *    wrapper (rgthree.js queueOutputNodes / initializeComfyUIHooks). The frontend never learns the
 *    run was scoped, which is why checking isPartialExecution alone let the group ▶ through.
 *
 * rgthree clears the field in a finally block, so it is only set for the duration of that submit.
 */
function scopedRunReason(options) {
    if (options?.isPartialExecution) return "코어 부분 실행";
    const ids = globalThis.rgthree?.queueNodeIds;
    if (Array.isArray(ids) && ids.length) return `rgthree 그룹/노드 큐 (노드 ${ids.length}개)`;
    return null;
}

function widgetValue(node, name) {
    const w = node?.widgets?.find((x) => x.name === name);
    return w ? w.value : undefined;
}

function isControlNode(node) {
    return node?.type === NODE_TYPE || node?.comfyClass === NODE_TYPE;
}

function titlesWidget(node) {
    // group_title was the old single-line name; keep reading it so a node deserialized by name
    // rather than by position still finds its value.
    return node?.widgets?.find((x) => x.name === "group_titles")
        ?? node?.widgets?.find((x) => x.name === "group_title");
}

/**
 * One group title per line.
 *
 * Newline is the only separator on purpose. Titles in these workflows contain commas and other
 * punctuation -- "D. 업스케일 · 보간 (전부 바이패스)" -- so splitting on anything else would tear a
 * title in half and then silently match nothing.
 */
function targetTitles(node) {
    const raw = String(titlesWidget(node)?.value ?? "");
    const seen = new Set();
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
        const title = line.trim();
        if (!title || seen.has(title)) continue;   // duplicate lines would double-count, not double-apply
        seen.add(title);
        out.push(title);
    }
    return out;
}

function setTitles(node, titles) {
    const w = titlesWidget(node);
    if (!w) return;
    w.value = titles.join("\n");
    w.callback?.(w.value);
    app.graph?.setDirtyCanvas?.(true, true);
}

function groupMembers(group) {
    // Groups own nodes geometrically and cache the list, so a node dragged in since the last
    // recompute would otherwise be missed.
    try {
        group.recomputeInsideNodes?.();
    } catch {
        /* not required on every build */
    }
    return group._nodes ?? group.nodes ?? [];
}

function applyFor(ctrl) {
    if (ctrl.mode === MODES.Bypass || ctrl.mode === MODES.Mute) return;
    if (widgetValue(ctrl, "enabled") === false) return;

    const titles = targetTitles(ctrl);
    if (!titles.length) return;

    const wanted = MODES[String(widgetValue(ctrl, "mode_during_run") ?? "Bypass")];
    if (wanted === undefined) return;

    const groups = (ctrl.graph ?? app.graph)?.groups ?? [];
    const missing = [];
    const applied = [];
    let changed = 0;

    for (const title of titles) {
        const group = groups.find((g) => String(g.title ?? "").trim() === title);
        if (!group) {
            // One bad line must not cost the user the other groups, so collect and carry on.
            missing.push(title);
            continue;
        }
        let n = 0;
        for (const node of groupMembers(group)) {
            if (node === ctrl) continue;        // never switch off its own settings
            // ...nor another Run Once node's. beforeQueued fires per node in graph order, so
            // bypassing a control node that has not run yet makes it hit its own
            // `ctrl.mode === Bypass` guard and silently do nothing -- an order-dependent failure
            // that only shows up once two of these nodes exist.
            if (isControlNode(node)) continue;
            // Overlapping groups are normal here -- A contains A-1 and A-2 -- so a node can be
            // reached twice. First claim wins and records the true original mode; a second claim
            // would record the already-switched mode and restore to the wrong value.
            if (tracked.has(node)) continue;
            if (node.mode === wanted) continue; // nothing to change, nothing to restore
            tracked.set(node, node.mode);
            node.mode = wanted;
            n += 1;
        }
        changed += n;
        applied.push(`"${title}" ${n}개`);
    }

    if (missing.length) {
        // Silence would be indistinguishable from the feature being broken.
        console.warn(`${TAG} 그룹을 찾지 못했습니다: ` +
            missing.map((t) => JSON.stringify(t)).join(", ") + " — 현재 그룹: " +
            groups.map((g) => JSON.stringify(String(g.title ?? ""))).join(", "));
    }
    if (changed) {
        console.log(`${TAG} ${applied.join(", ")} — 노드 ${changed}개를 ${MODE_NAME[wanted]} 로 ` +
            `전환. 실행이 끝나면 해제합니다.`);
    }
}

function release(reason) {
    if (!tracked.size) {
        resetCycle();
        return;
    }
    for (const [node, previous] of tracked) {
        node.mode = previous;
    }
    const n = tracked.size;
    tracked.clear();
    app.graph?.setDirtyCanvas?.(true, false);
    resetCycle();
    console.log(`${TAG} 실행 종료(${reason}) — 노드 ${n}개 원래 모드로 복원`);
}

function resetCycle() {
    cycle.active = false;
    cycle.sawStart = false;
    cycle.running = false;
}

/** Release only once the whole queue is done, not after the first prompt of a batch. */
function maybeRelease(reason) {
    if (!cycle.active || !cycle.sawStart) return;
    if (cycle.running) return;
    if (cycle.remaining !== 0) return;
    release(reason);
}

function readRemaining(detail) {
    const info = detail?.exec_info ?? detail?.status?.exec_info;
    const v = info?.queue_remaining;
    return typeof v === "number" ? v : null;
}

function installListeners() {
    if (typeof api?.addEventListener !== "function" || app.__sain3RunOnceListeners) return;

    api.addEventListener("status", ({ detail }) => {
        const r = readRemaining(detail);
        if (r !== null) cycle.remaining = r;
        maybeRelease("큐 비움");
    });

    api.addEventListener("execution_start", () => {
        cycle.sawStart = true;
        cycle.running = true;
    });

    for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(name, () => {
            cycle.running = false;
            // A completion event does not carry queue_remaining; the status event right after it
            // does. Try now in case this was the last prompt and remaining is already 0.
            maybeRelease(name.replace("execution_", ""));
        });
    }

    app.__sain3RunOnceListeners = true;
}

function installQueueHook() {
    if (typeof app?.queuePrompt !== "function" || app.__sain3RunOnceHooked) return;
    const original = app.queuePrompt;
    app.queuePrompt = async function (...args) {
        try {
            return await original.apply(this, args);
        } finally {
            // If the submit was rejected -- validation error, auth failure -- no execution_start
            // will ever arrive and the events above can never fire. Catch that case rather than
            // leaving the group bypassed indefinitely.
            if (cycle.active && !cycle.sawStart) {
                setTimeout(() => {
                    if (cycle.active && !cycle.sawStart) {
                        console.warn(`${TAG} 실행이 시작되지 않았습니다(제출 거부로 보임).`);
                        release("실행 없음");
                    }
                }, 2000);
            }
        }
    };
    app.__sain3RunOnceHooked = true;
}

/**
 * Hook the node's own widget object; only `.value` is serialized, so extra props are safe.
 *
 * The submit loop calls beforeQueued on every widget of every node, so any one of them would do --
 * but `group_titles` is now a multiline DOM widget, and DOM widgets can be recreated. Pin the hook
 * to the plain `enabled` toggle by name rather than to whatever lands at index 0.
 */
function attachHooks(node) {
    const w = node?.widgets?.find((x) => x.name === "enabled") ?? node?.widgets?.[0];
    if (!w || w.__sain3RunOnceHooked) return;
    w.__sain3RunOnceHooked = true;

    const prevBefore = w.beforeQueued;
    w.beforeQueued = function (options, ...rest) {
        prevBefore?.apply(this, [options, ...rest]);

        // Only the main Run button. Applying on a scoped run would be absurd: pressing ▶ on the
        // very group this node targets would bypass that group and leave nothing to execute.
        const scoped = scopedRunReason(options);
        if (scoped) {
            console.log(`${TAG} ${scoped} — 이번 제출은 건드리지 않습니다.`);
            return;
        }

        try {
            if (!cycle.active) {
                cycle.active = true;
                cycle.sawStart = false;
                cycle.running = false;
                cycle.remaining = null;
            }
            applyFor(node);
        } catch (error) {
            console.warn(`${TAG} 적용 실패, 그대로 제출합니다:`, error);
        }
    };
}

app.registerExtension({
    name: EXTENSION_NAME,

    setup() {
        installListeners();
        installQueueHook();
        // Autosave is off, so an unloaded page never persists the temporary state -- but restoring
        // here keeps the in-memory graph honest if the tab is merely navigated.
        window.addEventListener("beforeunload", () => {
            if (cycle.active) release("페이지 종료");
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            attachHooks(this);
            return r;
        };

        // Typing a group title by hand is the easy thing to get wrong -- one trailing space and it
        // silently matches nothing. Offer the real list, with a tick on the ones already chosen.
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            const node = this;
            const graphTitles = (node.graph ?? app.graph)?.groups
                ?.map((g) => String(g.title ?? "").trim())
                .filter(Boolean) ?? [];
            const chosen = targetTitles(node);
            const chosenSet = new Set(chosen);

            const entries = graphTitles.map((t) => ({
                // litegraph submenu entries have no checkbox, so the tick lives in the label.
                content: `${chosenSet.has(t) ? "✔" : " "} ${t}`,
                callback: () => {
                    // Toggle, preserving the order the user picked things in. Titles chosen while
                    // a group was named differently stay in the list untouched.
                    setTitles(node, chosenSet.has(t)
                        ? chosen.filter((x) => x !== t)
                        : [...chosen, t]);
                },
            }));
            if (chosen.length) {
                entries.push({
                    content: "— 모두 해제",
                    callback: () => setTitles(node, []),
                });
            }

            options.push({
                content: "그룹 고르기",
                has_submenu: true,
                submenu: {
                    options: entries.length
                        ? entries
                        : [{ content: "(그룹 없음)", disabled: true }],
                },
            });
            return options;
        };
    },
});
