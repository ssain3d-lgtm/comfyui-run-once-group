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
 * "Was the submit accepted?" and "has it started?" are different questions and must not share an
 * answer. A prompt queued behind a long job is accepted in milliseconds and starts minutes later,
 * so `execution_start` says nothing about whether the server took the submit -- an earlier version
 * used it that way and tore the modes down two seconds into any run queued behind another.
 * Acceptance is read from the POST /prompt result instead (installSubmitHook); what is still owed
 * is tracked by prompt_id.
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

/**
 * Grace period before believing a queue that reports itself empty while we are still owed results.
 * Clearing the queue discards pending prompts without emitting anything per prompt, so their ids
 * would otherwise be outstanding forever; a stale status broadcast is corrected well inside this.
 */
const SWEEP_DELAY = 1500;

/**
 * Grace period before calling a submit refused. The server broadcasts the queue change as it puts
 * the prompt on the queue, i.e. before the POST it is answering even returns, so this waits on
 * something measured in milliseconds -- unlike the execution_start it replaces, which a queue with
 * work ahead of it can legitimately delay for minutes.
 */
const REFUSED_GRACE = 500;

// LiteGraph node modes. 0 ALWAYS, 2 NEVER (Mute), 4 BYPASS.
const MODES = { Active: 0, Mute: 2, Bypass: 4 };
const MODE_NAME = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));
const MODE_COLOR = { 0: "#3d8b55", 2: "#6f6f78", 4: "#7a5bb5" };

/** node -> mode it had before this cycle. Survives the whole run, across batch items. */
const tracked = new Map();

/** control node -> how many nodes it is currently holding. Drives the on-canvas badge. */
const heldBy = new Map();

const cycle = {
    active: false,        // something is applied and not yet released
    accepted: 0,          // submits this cycle that the server acknowledged
    pending: new Set(),   // prompt_ids of ours that have not reported a result yet
    running: false,       // between execution_start and its completion event
    remaining: null,      // last queue_remaining reported by the server
    sweep: null,          // timer for the "queue empty but ids outstanding" backstop
    refuse: null,         // timer for the "server acknowledged nothing" check
};

/** Nested app.queuePrompt calls in flight. ComfyUI re-enters it while a batch is draining. */
let submitDepth = 0;

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
    if (options?.isPartialExecution) return "core partial execution";
    const ids = globalThis.rgthree?.queueNodeIds;
    if (Array.isArray(ids) && ids.length) return `rgthree group/node queue (${ids.length} nodes)`;
    return null;
}

function widgetValue(node, name) {
    const w = node?.widgets?.find((x) => x.name === name);
    return w ? w.value : undefined;
}

function isControlNode(node) {
    return node?.type === NODE_TYPE || node?.comfyClass === NODE_TYPE;
}

/** Warnings belong where the user is looking. The console keeps the detail either way. */
function notify(severity, summary, detail) {
    try {
        app.extensionManager?.toast?.add({ severity, summary, detail, life: 6000 });
    } catch {
        /* older frontends have no toast host */
    }
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
 * punctuation -- "D. Upscale, Interpolate (all bypassed)" -- so splitting on anything else would
 * tear a title in half and then silently match nothing.
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

function graphGroups(node) {
    return (node?.graph ?? app.graph)?.groups ?? [];
}

/** Split the node's chosen titles into the ones that name a real group and the ones that do not. */
function resolveTitles(node, titles = targetTitles(node)) {
    const byTitle = new Map();
    for (const g of graphGroups(node)) {
        const title = String(g.title ?? "").trim();
        if (title && !byTitle.has(title)) byTitle.set(title, g);
    }
    const found = [];
    const missing = [];
    for (const t of titles) (byTitle.has(t) ? found : missing).push(t);
    return { byTitle, found, missing };
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

    const { byTitle, missing } = resolveTitles(ctrl, titles);
    const applied = [];
    let changed = 0;

    for (const title of titles) {
        const group = byTitle.get(title);
        // One bad line must not cost the user the other groups, so carry on; `missing` has it.
        if (!group) continue;
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
        applied.push(`"${title}" ${n}`);
    }

    if (changed) heldBy.set(ctrl, changed);

    if (missing.length) {
        // Silence would be indistinguishable from the feature being broken. The badge on the node
        // shows the same shortfall before the run; this reports it at the moment it costs work.
        const list = missing.map((t) => JSON.stringify(t)).join(", ");
        console.warn(`${TAG} no such group: ${list} — groups in this graph: ` +
            graphGroups(ctrl).map((g) => JSON.stringify(String(g.title ?? ""))).join(", "));
        notify("warn", `${TAG} group not found`, missing.join(", "));
    }
    if (changed) {
        console.log(`${TAG} ${applied.join(", ")} — ${changed} nodes switched to ` +
            `${MODE_NAME[wanted]}. Released when the run ends.`);
    }
}

function release(reason) {
    const n = tracked.size;
    for (const [node, previous] of tracked) {
        node.mode = previous;
    }
    tracked.clear();
    heldBy.clear();
    resetCycle();
    app.graph?.setDirtyCanvas?.(true, true);
    if (n) console.log(`${TAG} run finished (${reason}) — ${n} nodes restored to their original mode`);
}

function resetCycle() {
    cycle.active = false;
    cycle.accepted = 0;
    cycle.running = false;
    cycle.remaining = null;
    cycle.pending.clear();
    clearSweep();
    if (cycle.refuse !== null) {
        clearTimeout(cycle.refuse);
        cycle.refuse = null;
    }
}

function startCycle() {
    resetCycle();
    cycle.active = true;
}

function clearSweep() {
    if (cycle.sweep === null) return;
    clearTimeout(cycle.sweep);
    cycle.sweep = null;
}

/**
 * Release only once the whole queue is done, not after the first prompt of a batch.
 *
 * `accepted` is the gate rather than "an execution_start arrived": the server acknowledging the
 * POST is what makes a run real, and it does that regardless of how long the queue makes us wait
 * to start. `pending` then keeps a stale status broadcast from releasing the instant we submit.
 */
function maybeRelease(reason) {
    if (!cycle.active) return;
    if (!cycle.accepted) return;        // nothing of ours ever reached the server
    if (cycle.running) return;          // a prompt is mid-execution
    if (cycle.remaining !== 0) return;  // the server still has work queued
    if (cycle.pending.size) {
        armSweep(reason);
        return;
    }
    release(reason);
}

/**
 * The queue says empty while prompts of ours have never reported a result. Clearing the queue does
 * exactly that -- pending prompts are dropped without an event each -- so after a grace period the
 * ids are dead and holding the graph hostage to them would strand the user's modes.
 */
function armSweep(reason) {
    if (cycle.sweep !== null) return;
    cycle.sweep = setTimeout(() => {
        cycle.sweep = null;
        if (!cycle.active || cycle.running || cycle.remaining !== 0 || !cycle.pending.size) return;
        console.warn(`${TAG} the queue is empty but ${cycle.pending.size} prompt(s) never ` +
            `reported a result (queue cleared?) — restoring.`);
        cycle.pending.clear();
        release(reason);
    }, SWEEP_DELAY);
}

function readRemaining(detail) {
    const info = detail?.exec_info ?? detail?.status?.exec_info;
    const v = info?.queue_remaining;
    return typeof v === "number" ? v : null;
}

/** /prompt answers 400 on a validation failure, so merely resolving is most of the signal. */
function wasAccepted(res) {
    const errors = res?.node_errors;
    if (errors && Object.keys(errors).length) return false;
    return true;
}

function installListeners() {
    if (typeof api?.addEventListener !== "function" || app.__sain3RunOnceListeners) return;

    api.addEventListener("status", ({ detail }) => {
        const r = readRemaining(detail);
        if (r !== null) {
            cycle.remaining = r;
            if (r > 0) {
                clearSweep();
                // Belt and braces: if another extension replaced api.queuePrompt without chaining
                // ours, the POST result never reaches us and `accepted` stays 0. A queue that grew
                // says work exists, so err towards holding rather than tearing down a live run.
                if (cycle.active && !cycle.accepted) cycle.accepted = 1;
            }
        }
        maybeRelease("queue empty");
    });

    api.addEventListener("execution_start", () => {
        cycle.running = true;
        clearSweep();
    });

    for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(name, ({ detail }) => {
            cycle.running = false;
            const id = detail?.prompt_id;
            if (id) cycle.pending.delete(id);
            // A completion event does not carry queue_remaining; the status event right after it
            // does. Try now in case this was the last prompt and remaining is already 0.
            maybeRelease(name.replace("execution_", ""));
        });
    }

    app.__sain3RunOnceListeners = true;
}

/**
 * Read acceptance straight off the POST.
 *
 * This is the whole fix for the old two-second net. `api.queuePrompt` throws when the server
 * refuses the prompt and resolves with a prompt_id when it takes it, both within milliseconds of
 * the submit and both independent of how much work is queued ahead of us.
 *
 * Chaining is safe in either install order: rgthree wraps this function too, so whoever installs
 * second wraps the first and every call still passes through both.
 */
function installSubmitHook() {
    if (typeof api?.queuePrompt !== "function" || api.__sain3RunOnceSubmitHook) return;
    const original = api.queuePrompt;
    api.queuePrompt = async function (...args) {
        const res = await original.apply(this, args);
        if (cycle.active && wasAccepted(res)) {
            cycle.accepted += 1;
            const id = res?.prompt_id;
            if (id) cycle.pending.add(id);
            // A sweep armed before this submit was judging an older, emptier queue. Results are
            // owed again, so that verdict is void -- without this, a Run pressed inside the sweep
            // window could be torn down by the stale timer before the status broadcast lands.
            clearSweep();
        }
        return res;
    };
    api.__sain3RunOnceSubmitHook = true;
}

function installQueueHook() {
    if (typeof app?.queuePrompt !== "function" || app.__sain3RunOnceHooked) return;
    const original = app.queuePrompt;
    app.queuePrompt = async function (...args) {
        // ComfyUI re-enters queuePrompt while a batch drains and returns early from the inner
        // call, so only the outermost one knows the submit is really over.
        submitDepth += 1;
        try {
            return await original.apply(this, args);
        } finally {
            submitDepth -= 1;
            if (submitDepth <= 0) {
                submitDepth = 0;
                afterSubmit();
            }
        }
    };
    app.__sain3RunOnceHooked = true;
}

/**
 * The submit is over and the server acknowledged none of it -- validation error, auth failure,
 * server down. Nothing was queued, so no event will ever arrive to release the modes.
 *
 * The short wait is for the one case where the POST result cannot reach us: an extension that
 * replaced api.queuePrompt without chaining ours. A queue that grew is then the only evidence the
 * run is real, and it arrives by websocket within a few milliseconds -- so wait that out rather
 * than tear the modes down under a run that is genuinely happening.
 *
 * ComfyUI already puts its own dialog on screen for a refusal, so the console line is enough here.
 */
function afterSubmit() {
    if (!cycle.active || cycle.accepted || cycle.refuse !== null) return;
    cycle.refuse = setTimeout(() => {
        cycle.refuse = null;
        if (!cycle.active || cycle.accepted) return;
        if (tracked.size) {
            console.warn(`${TAG} the submit was refused — nothing queued, restoring now.`);
        }
        release("submit refused");
    }, REFUSED_GRACE);
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
            console.log(`${TAG} ${scoped} — leaving this submit alone.`);
            return;
        }

        try {
            if (!cycle.active) startCycle();
            applyFor(node);
        } catch (error) {
            console.warn(`${TAG} could not apply, submitting unchanged:`, error);
        }
    };
}

/* ---------------------------------------------------------------- on-canvas state */

/**
 * What the node should say about itself, without opening the console.
 *
 * Typing a title by hand is the easy thing to get wrong and a renamed group breaks a list that
 * used to work, so the counts are shown before the run rather than only warned about after it.
 */
function statusFor(node) {
    const held = heldBy.get(node);
    if (held) {
        const wanted = MODES[String(widgetValue(node, "mode_during_run") ?? "Bypass")];
        return { text: `holding ${held}`, bg: MODE_COLOR[wanted] ?? "#7a5bb5", fg: "#f2f2f2" };
    }
    if (widgetValue(node, "enabled") === false) return { text: "off", bg: "#3a3a40", fg: "#9a9aa2" };

    const titles = targetTitles(node);
    if (!titles.length) return { text: "no groups", bg: "#3a3a40", fg: "#9a9aa2" };

    const { found, missing } = resolveTitles(node, titles);
    if (missing.length) {
        return { text: `${found.length}/${titles.length} groups`, bg: "#7a3b32", fg: "#ffd9d2" };
    }
    return { text: `${found.length} group${found.length === 1 ? "" : "s"}`, bg: "#3a3a40", fg: "#c8c8d0" };
}

/** Drawn in the title bar: the node body is a multiline textarea overlay with no room to spare. */
function drawStatusBadge(node, ctx) {
    if (node.flags?.collapsed) return;
    const status = statusFor(node);
    if (!status) return;

    const titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    const h = 15;
    const y = -titleHeight + (titleHeight - h) / 2;

    ctx.save();
    ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
    const w = Math.ceil(ctx.measureText(status.text).width) + 12;
    const x = node.size[0] - w - 6;
    // A very narrow node would put the badge on top of the title; the title matters more.
    if (x < node.size[0] * 0.35) {
        ctx.restore();
        return;
    }

    ctx.beginPath();
    ctx.roundRect?.(x, y, w, h, 4);
    if (!ctx.roundRect) ctx.rect(x, y, w, h);
    ctx.fillStyle = status.bg;
    ctx.fill();

    ctx.fillStyle = status.fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(status.text, x + w / 2, y + h / 2 + 0.5);
    ctx.restore();
}

/* ---------------------------------------------------------------- group picker */

/**
 * Entries for the picker, ticked where already chosen.
 *
 * Chosen titles that match nothing get their own ✖ rows. The list used to be built purely from the
 * graph, so a renamed or deleted group left a line in the widget that the picker never mentioned
 * again -- invisible, unmatched, and only findable by reading the console after a run.
 */
function pickerEntries(node) {
    const graphTitles = graphGroups(node)
        .map((g) => String(g.title ?? "").trim())
        .filter(Boolean);
    const chosen = targetTitles(node);
    const chosenSet = new Set(chosen);
    const graphSet = new Set(graphTitles);

    const entries = graphTitles.map((t) => ({
        // litegraph submenu entries have no checkbox, so the tick lives in the label.
        content: `${chosenSet.has(t) ? "✔" : " "} ${t}`,
        callback: () => {
            // Toggle, preserving the order the user picked things in.
            setTitles(node, chosenSet.has(t)
                ? chosen.filter((x) => x !== t)
                : [...chosen, t]);
        },
    }));

    for (const t of chosen.filter((x) => !graphSet.has(x))) {
        entries.push({
            content: `✖ ${t}  (not in this graph)`,
            callback: () => setTitles(node, chosen.filter((x) => x !== t)),
        });
    }

    if (chosen.length) {
        entries.push({ content: "— Clear all", callback: () => setTitles(node, []) });
    }
    return entries.length ? entries : [{ content: "(no groups)", disabled: true }];
}

/** The right-click submenu is the litegraph idiom; the button is for everyone who never tries it. */
function openPicker(node, event) {
    const Menu = globalThis.LiteGraph?.ContextMenu;
    if (!Menu) {
        console.warn(`${TAG} no ContextMenu available — right-click the node to pick groups.`);
        return;
    }
    try {
        new Menu(pickerEntries(node), { title: "Pick groups", event, scale: 1.1 });
    } catch (error) {
        console.warn(`${TAG} could not open the picker, use right-click instead:`, error);
    }
}

app.registerExtension({
    name: EXTENSION_NAME,

    setup() {
        installListeners();
        installSubmitHook();
        installQueueHook();
        // Autosave is off, so an unloaded page never persists the temporary state -- but restoring
        // here keeps the in-memory graph honest if the tab is merely navigated.
        window.addEventListener("beforeunload", () => {
            if (cycle.active) release("page unload");
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            attachHooks(this);
            // Appended last and flagged non-serializing, so `widgets_values` keeps the positional
            // layout every saved workflow was written against: enabled, group_titles, mode.
            const button = this.addWidget?.("button", "Pick groups", null,
                (_value, _canvas, node, _pos, event) => openPicker(node ?? this, event));
            if (button) button.serialize = false;
            return r;
        };

        // A workflow saved before the button existed stored a height with no room for it, and a
        // clipped button is worse than none.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            const min = this.computeSize?.();
            if (min && this.size && this.size[1] < min[1]) this.size[1] = min[1];
            return r;
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            const r = onDrawForeground?.apply(this, arguments);
            try {
                drawStatusBadge(this, ctx);
            } catch {
                /* never let a badge break canvas rendering */
            }
            return r;
        };

        // Typing a group title by hand is the easy thing to get wrong -- one trailing space and it
        // silently matches nothing. Offer the real list, with a tick on the ones already chosen.
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: "Pick groups",
                has_submenu: true,
                submenu: { options: pickerEntries(this) },
            });
            return options;
        };
    },
});
