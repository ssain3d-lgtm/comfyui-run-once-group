/**
 * Test double for ComfyUI's scripts/app.js, faithful to the parts the extension touches.
 *
 * This directory exists at the repository root for one reason: web/js/run_once_group.js imports
 * "../../scripts/app.js", which ComfyUI serves from its own web root and node therefore resolves
 * to right here. The tests get to load the real, unmodified extension file with no copy step and
 * no bundler. ComfyUI only ever serves WEB_DIRECTORY (./web/js), so it never sees this folder.
 */
import { api } from "./api.js";

export const extensions = [];

/**
 * graph.serialize() mirrors LGraphNode.serialize(): `mode` is filled from the live node and the
 * object is only then handed to onSerialize, which may rewrite it. That ordering is the whole
 * mechanism behind keeping a mid-run save clean, so the double has to reproduce it exactly.
 */
function makeGraph() {
    return {
        groups: [],
        _nodes: [],
        setDirtyCanvas() {},
        serialize() {
            return {
                nodes: this._nodes.map((n) => {
                    const o = { id: n.id, type: n.type, mode: n.mode };
                    n.onSerialize?.(o);
                    return o;
                }),
            };
        },
    };
}

/**
 * ComfyUI's real one delegates to a util that calls graph.serialize() for the workflow embedded
 * beside the prompt, while the prompt itself is built from live node.mode. Both halves matter to
 * the extension, so both are modelled.
 */
async function baseGraphToPrompt() {
    await Promise.resolve();
    const live = (app.graph._nodes || [])
        .filter((n) => n.mode !== 4 && n.mode !== 2)
        .map((n) => n.id);
    return { workflow: app.graph.serialize(), output: { executed: live } };
}

/**
 * Mirrors app.js: beforeQueued on every widget of every node, then graphToPrompt, then POST.
 * Errors from api.queuePrompt are swallowed (ComfyUI shows a dialog instead of rethrowing).
 */
async function baseQueuePrompt(number, batchCount = 1, queueNodeIds = null) {
    const isPartialExecution = !!queueNodeIds?.length;
    app.lastNodeErrors = null;
    for (let i = 0; i < batchCount; i++) {
        for (const n of app.graph._nodes || []) {
            for (const w of n.widgets || []) w.beforeQueued?.({ isPartialExecution });
        }
        try {
            const res = await api.queuePrompt(number, await app.graphToPrompt());
            app.lastNodeErrors = res.node_errors;
        } catch {
            break;   // ComfyUI breaks out of the batch loop on a refused submit
        }
    }
    return !Object.keys(app.lastNodeErrors || {}).length;
}

export const app = {
    graph: makeGraph(),
    canvas: {},
    extensionManager: { toast: { _sent: [], add(t) { this._sent.push(t); } } },

    registerExtension(ext) {
        extensions.push(ext);
    },

    queuePrompt: baseQueuePrompt,

    graphToPrompt: baseGraphToPrompt,

    reset() {
        this.graph = makeGraph();
        this.extensionManager.toast._sent = [];
        // Drop every wrapper a previous test installed. Miss one and the stale wrapper keeps
        // driving the previous module instance's state while the fresh one sits at its defaults.
        this.queuePrompt = baseQueuePrompt;
        this.graphToPrompt = baseGraphToPrompt;
        delete this.__sain3RunOnceListeners;
        delete this.__sain3RunOnceHooked;
        delete this.__sain3RunOncePromptHooked;
        extensions.length = 0;
        api.reset();
    },
};
