/**
 * Behavioural tests for the Run Once group toggle frontend.  Run with: node tests/run.mjs
 *
 * These load web/js/run_once_group.js exactly as shipped -- the test doubles in ../scripts are
 * what its "../../scripts/app.js" import resolves to under node. No network, no ComfyUI.
 *
 * The extension keeps `tracked` and `cycle` at module level, so each test imports a fresh copy
 * with a cache-busting query while the app/api doubles stay singletons and are reset by hand.
 */
import assert from "node:assert/strict";
import { app, extensions } from "../scripts/app.js";
import { api } from "../scripts/api.js";

globalThis.window = { addEventListener() {} };
globalThis.LiteGraph = {
    NODE_TITLE_HEIGHT: 30,
    ContextMenu: class { constructor(entries) { this.entries = entries; } },
};

const MODE = { Active: 0, Mute: 2, Bypass: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let build = 0;
let results = [];

/* ------------------------------------------------------------------ scaffolding */

function makeNode(id, mode = MODE.Active) {
    return { id, mode, widgets: [], flags: {}, size: [220, 120], pos: [0, 0] };
}

function makeGroup(title, nodes) {
    return { title, _nodes: nodes, recomputeInsideNodes() {} };
}

/** A control node built the way ComfyUI builds it: three widgets, in order. */
function makeControl(ext, { titles = "", mode = "Bypass", enabled = true } = {}) {
    const nodeType = function () {};
    nodeType.prototype = {};
    ext.beforeRegisterNodeDef(nodeType, { name: "RunOnceGroupMode" });

    const node = makeNode("ctrl");
    node.type = "RunOnceGroupMode";
    node.comfyClass = "RunOnceGroupMode";
    node.graph = app.graph;
    node.widgets = [
        { name: "enabled", value: enabled },
        { name: "group_titles", value: titles },
        { name: "mode_during_run", value: mode },
    ];
    node.addWidget = (type, name, value, callback) => {
        const w = { type, name, value, callback };
        node.widgets.push(w);
        return w;
    };
    node.computeSize = () => [220, 160];
    Object.assign(node, nodeType.prototype);
    node.onNodeCreated?.();
    node._proto = nodeType.prototype;
    return node;
}

async function setupExtension() {
    app.reset();
    const mod = await import(`../web/js/run_once_group.js?build=${++build}`);
    void mod;
    const ext = extensions[extensions.length - 1];
    ext.setup();
    return ext;
}

async function test(name, fn) {
    try {
        await fn();
        results.push([true, name]);
    } catch (error) {
        results.push([false, `${name}\n      ${error.message}`]);
    }
}

/* ------------------------------------------------------------------ the fix */

await test("busy queue: an accepted submit stays applied past the old 2s net", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    const b = makeNode("b");
    app.graph.groups = [makeGroup("Upscale", [a, b])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a, b];

    // Another job is already running: the server reports a non-empty queue and our
    // execution_start will not arrive for a long time.
    api.status(1);
    await app.queuePrompt(0, 1);
    assert.equal(api.accepted.length, 1, "the submit should have been accepted");
    assert.equal(a.mode, MODE.Bypass);

    await sleep(2300);   // comfortably past the 2000ms timer the old build used
    assert.equal(a.mode, MODE.Bypass, "still bypassed while queued behind another job");
    assert.equal(b.mode, MODE.Bypass);

    // Now our prompt finally runs.
    api.emit("execution_start", { prompt_id: api.accepted[0] });
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(0);
    assert.equal(a.mode, MODE.Active, "restored once the queue drains");
    assert.equal(b.mode, MODE.Active);
});

await test("refused submit restores inside the grace period", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    api.mode = "refuse";
    await app.queuePrompt(0, 1);
    await sleep(700);
    assert.equal(a.mode, MODE.Active, "restored without needing an execution_start that never comes");
});

await test("a 200 carrying node_errors counts as refused", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    api.mode = "node_errors";
    await app.queuePrompt(0, 1);
    await sleep(700);
    assert.equal(a.mode, MODE.Active);
});

await test("a stale status(0) arriving right after acceptance does not release", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    api.status(0);   // broadcast generated before our queue put, delivered after
    assert.equal(a.mode, MODE.Bypass, "our prompt_id is still outstanding");

    api.status(1);
    api.emit("execution_start", { prompt_id: api.accepted[0] });
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

await test("cleared queue: outstanding ids are swept and the modes come back", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);

    api.status(0);          // user pressed Clear Queue: no per-prompt event ever arrives
    assert.equal(a.mode, MODE.Bypass, "not released instantly -- could be a stale broadcast");
    await sleep(1700);
    assert.equal(a.mode, MODE.Active, "swept after the grace period");
});

await test("a resubmit inside the sweep window is not torn down by the stale sweep", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    api.status(0);          // queue cleared: p1 will never report, the sweep is armed
    await sleep(300);

    // The user immediately runs again. Acceptance must void the armed sweep even if the
    // queue-change broadcast is slow to arrive.
    await app.queuePrompt(0, 1);
    await sleep(1400);      // past the original sweep deadline, no status received yet
    assert.equal(a.mode, MODE.Bypass, "the fresh run survives the old timer");

    api.emit("execution_start", { prompt_id: api.accepted[1] });
    api.emit("execution_success", { prompt_id: api.accepted[1] });
    api.status(0);
    assert.equal(a.mode, MODE.Bypass, "p1 is still owed, so this arms a legitimate sweep");
    await sleep(1700);
    assert.equal(a.mode, MODE.Active, "and the dead p1 is then swept normally");
});

await test("batch of two releases once, at the end", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 2);
    assert.equal(api.accepted.length, 2);
    assert.equal(a.mode, MODE.Bypass);

    api.emit("execution_start", { prompt_id: api.accepted[0] });
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(1);
    assert.equal(a.mode, MODE.Bypass, "one still queued");

    api.emit("execution_start", { prompt_id: api.accepted[1] });
    api.emit("execution_success", { prompt_id: api.accepted[1] });
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

await test("interrupt takes the normal release path", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    api.emit("execution_start", { prompt_id: api.accepted[0] });
    api.emit("execution_interrupted", { prompt_id: api.accepted[0] });
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

await test("acceptance is inferred when the POST result never reaches us", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    // Simulate a third-party extension that replaced api.queuePrompt without chaining ours.
    api.queuePrompt = async () => ({ prompt_id: "x1", number: 0, node_errors: {} });

    await app.queuePrompt(0, 1);
    api.status(1);   // the queue grew all the same, and does so well inside the grace period
    await sleep(700);
    assert.equal(a.mode, MODE.Bypass, "held rather than torn down under a live run");
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

/* ------------------------------------------------------------------ saving mid-run */

const modeOf = (workflow, id) => workflow.nodes.find((n) => n.id === id).mode;

await test("a save made mid-run writes the modes the user actually built", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    const b = makeNode("b", MODE.Mute);
    app.graph.groups = [makeGroup("Upscale", [a, b])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a, b];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass, "held on the canvas");

    // What Ctrl+S writes: graph.serialize() outside graphToPrompt.
    const saved = app.graph.serialize();
    assert.equal(modeOf(saved, "a"), MODE.Active, "restored to its real mode on disk");
    assert.equal(modeOf(saved, "b"), MODE.Mute, "and not to a guessed default");
    assert.equal(a.mode, MODE.Bypass, "saving does not disturb the live graph");
});

await test("the workflow embedded beside the prompt still records what ran", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    const { workflow, output } = await app.graphToPrompt();
    assert.equal(modeOf(workflow, "a"), MODE.Bypass, "provenance: the image says it was bypassed");
    assert.ok(!output.executed.includes("a"), "and the prompt itself skipped it");
});

await test("serialization is normal again once the run releases", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    api.emit("execution_start", {});
    api.emit("execution_success", { prompt_id: api.accepted.at(-1) });
    api.status(0);

    a.mode = MODE.Mute;   // the user changes it by hand after the run
    assert.equal(modeOf(app.graph.serialize(), "a"), MODE.Mute, "the guard is inert once released");
});

await test("a node that already had an onSerialize keeps it", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    let called = 0;
    a.onSerialize = (o) => { called += 1; o.marker = "mine"; };
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    const saved = app.graph.serialize();
    assert.equal(called > 0, true, "the original hook still runs");
    assert.equal(saved.nodes.find((n) => n.id === "a").marker, "mine");
    assert.equal(modeOf(saved, "a"), MODE.Active, "and ours still corrects the mode");
});

/* ------------------------------------------------------------------ regressions */

await test("scoped run (core partial execution) is left alone", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1, [7]);
    assert.equal(a.mode, MODE.Active, "never applied");
    api.status(0);
    assert.equal(a.mode, MODE.Active);

    // ...and the very next main Run still works. The scoped submit already consumed p1, so the
    // main run's prompt is the last one the server accepted.
    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
    api.emit("execution_start", {});
    api.emit("execution_success", { prompt_id: api.accepted.at(-1) });
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

await test("scoped run (rgthree group play) is left alone", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    globalThis.rgthree = { queueNodeIds: [1, 2] };
    await app.queuePrompt(0);
    assert.equal(a.mode, MODE.Active);
    delete globalThis.rgthree;
});

await test("one bad title still applies the good ones and warns", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale\nTypo Group" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
    const toast = app.extensionManager.toast._sent;
    assert.equal(toast.length, 1, "a toast names the missing group");
    assert.match(toast[0].detail, /Typo Group/);
});

await test("overlapping groups restore a node to its real Mute value", async () => {
    const ext = await setupExtension();
    const a = makeNode("a", MODE.Mute);
    app.graph.groups = [makeGroup("A", [a]), makeGroup("A-1", [a])];
    const ctrl = makeControl(ext, { titles: "A\nA-1" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
    api.emit("execution_start", {});
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(0);
    assert.equal(a.mode, MODE.Mute, "not Active");
});

await test("two control nodes cooperate and never target each other", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    const b = makeNode("b", MODE.Bypass);
    const ctrlA = makeControl(ext, { titles: "A", mode: "Bypass" });
    const ctrlB = makeControl(ext, { titles: "B", mode: "Active" });
    app.graph.groups = [makeGroup("A", [a, ctrlB]), makeGroup("B", [b, ctrlA])];
    app.graph._nodes = [ctrlA, ctrlB, a, b];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
    assert.equal(b.mode, MODE.Active);
    assert.equal(ctrlA.mode, MODE.Active, "control nodes untouched");
    assert.equal(ctrlB.mode, MODE.Active);

    api.emit("execution_start", {});
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(0);
    assert.equal(a.mode, MODE.Active);
    assert.equal(b.mode, MODE.Bypass);
});

await test("enabled=false does nothing at all", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale", enabled: false });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Active);
    api.status(0);
    assert.equal(a.mode, MODE.Active);
});

await test("whitespace, blank lines and duplicates are cleaned", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "  Upscale  \n\n\tUpscale\n" });
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
    assert.equal(app.extensionManager.toast._sent.length, 0, "no phantom missing group");
});

await test("the older group_title widget name still works", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "" });
    ctrl.widgets[1].name = "group_title";
    ctrl.widgets[1].value = "Upscale";
    app.graph._nodes = [ctrl, a];

    await app.queuePrompt(0, 1);
    assert.equal(a.mode, MODE.Bypass);
});

/* ------------------------------------------------------------------ new UI */

await test("the picker lists graph groups, ticks the chosen, and flags stale titles", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a]), makeGroup("Interpolate", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale\nRenamed Away" });
    app.graph._nodes = [ctrl, a];

    const options = [];
    ctrl.getExtraMenuOptions(app.canvas, options);
    const entries = options.at(-1).submenu.options.map((e) => e.content);

    assert.ok(entries.some((c) => c.startsWith("✔") && c.includes("Upscale")), "chosen is ticked");
    assert.ok(entries.some((c) => c.includes("Interpolate") && !c.startsWith("✔")), "unchosen listed");
    assert.ok(entries.some((c) => c.startsWith("✖") && c.includes("Renamed Away")),
        "a title matching no group is visible so it can be removed");
    assert.ok(entries.some((c) => c.includes("Clear all")));
});

await test("clicking a stale entry removes just that line", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale\nRenamed Away" });
    app.graph._nodes = [ctrl, a];

    const options = [];
    ctrl.getExtraMenuOptions(app.canvas, options);
    options.at(-1).submenu.options.find((e) => e.content.startsWith("✖")).callback();
    assert.equal(ctrl.widgets[1].value, "Upscale");
});

await test("the Pick groups button is appended last and does not serialize", async () => {
    const ext = await setupExtension();
    const ctrl = makeControl(ext, { titles: "" });
    assert.deepEqual(ctrl.widgets.map((w) => w.name),
        ["enabled", "group_titles", "mode_during_run", "Pick groups"],
        "the three real widgets keep slots 0-2 so widgets_values still restores positionally");
    assert.equal(ctrl.widgets[3].serialize, false);
});

await test("the button opens the same picker", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "" });
    app.graph._nodes = [ctrl, a];

    let opened = null;
    const RealMenu = globalThis.LiteGraph.ContextMenu;
    globalThis.LiteGraph.ContextMenu = class { constructor(e) { opened = e; } };
    ctrl.widgets[3].callback(null, app.canvas, ctrl, [0, 0], {});
    globalThis.LiteGraph.ContextMenu = RealMenu;

    assert.ok(opened, "a menu was opened");
    assert.ok(opened.some((e) => e.content.includes("Upscale")));
});

await test("a node saved before the button existed is grown to fit it", async () => {
    const ext = await setupExtension();
    const ctrl = makeControl(ext, { titles: "" });
    ctrl.size = [220, 100];          // height stored by an older build
    ctrl.onConfigure();
    assert.equal(ctrl.size[1], 160, "grown to computeSize");

    ctrl.size = [220, 400];          // a height the user set by hand
    ctrl.onConfigure();
    assert.equal(ctrl.size[1], 400, "never shrunk");
});

await test("the badge reports groups, shortfalls, held count and off", async () => {
    const ext = await setupExtension();
    const a = makeNode("a");
    app.graph.groups = [makeGroup("Upscale", [a])];
    const ctrl = makeControl(ext, { titles: "Upscale" });
    app.graph._nodes = [ctrl, a];

    const drawn = [];
    const ctx = {
        save() {}, restore() {}, beginPath() {}, rect() {}, roundRect() {}, fill() {},
        measureText: (t) => ({ width: t.length * 6 }),
        fillText: (t) => drawn.push(t),
    };

    ctrl.onDrawForeground(ctx);
    assert.equal(drawn.at(-1), "1 group");

    ctrl.widgets[1].value = "Upscale\nGone";
    ctrl.onDrawForeground(ctx);
    assert.equal(drawn.at(-1), "1/2 groups", "the shortfall is visible without the console");

    ctrl.widgets[1].value = "Upscale";
    await app.queuePrompt(0, 1);
    ctrl.onDrawForeground(ctx);
    assert.equal(drawn.at(-1), "holding 1");

    api.emit("execution_start", {});
    api.emit("execution_success", { prompt_id: api.accepted[0] });
    api.status(0);
    ctrl.onDrawForeground(ctx);
    assert.equal(drawn.at(-1), "1 group", "the badge goes back after the run");

    ctrl.widgets[0].value = false;
    ctrl.onDrawForeground(ctx);
    assert.equal(drawn.at(-1), "off");
});

/* ------------------------------------------------------------------ report */

const failed = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
console.log(`\n${results.length - failed.length} pass / ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
