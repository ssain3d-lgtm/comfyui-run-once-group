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
            const res = await api.queuePrompt(number, { output: {} });
            app.lastNodeErrors = res.node_errors;
        } catch {
            break;   // ComfyUI breaks out of the batch loop on a refused submit
        }
    }
    return !Object.keys(app.lastNodeErrors || {}).length;
}

export const app = {
    graph: { groups: [], _nodes: [], setDirtyCanvas() {} },
    canvas: {},
    extensionManager: { toast: { _sent: [], add(t) { this._sent.push(t); } } },

    registerExtension(ext) {
        extensions.push(ext);
    },

    queuePrompt: baseQueuePrompt,

    reset() {
        this.graph = { groups: [], _nodes: [], setDirtyCanvas() {} };
        this.extensionManager.toast._sent = [];
        this.queuePrompt = baseQueuePrompt;   // drop any wrapper a previous test installed
        delete this.__sain3RunOnceListeners;
        delete this.__sain3RunOnceHooked;
        extensions.length = 0;
        api.reset();
    },
};
