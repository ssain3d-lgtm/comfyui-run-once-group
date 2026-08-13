/**
 * Test double for ComfyUI's scripts/api.js: an event target plus the /prompt POST.
 * See app.js in this directory for why these live at the repository root.
 */

async function basePost(number) {
    await Promise.resolve();
    if (api.mode === "refuse") {
        const err = new Error("Prompt has no outputs");
        err.response = { node_errors: { 3: {} } };
        throw err;
    }
    if (api.mode === "node_errors") {
        return { prompt_id: null, number, node_errors: { 3: { errors: [] } } };
    }
    const prompt_id = `p${api._nextPromptId++}`;
    api.accepted.push(prompt_id);
    return { prompt_id, number, node_errors: {} };
}

export const api = {
    _listeners: {},
    _nextPromptId: 1,
    /** Test knob: "ok" | "refuse" | "node_errors" */
    mode: "ok",
    accepted: [],

    addEventListener(name, fn) {
        (this._listeners[name] ||= []).push(fn);
    },
    emit(name, detail) {
        for (const fn of this._listeners[name] || []) fn({ detail });
    },
    status(queue_remaining) {
        this.emit("status", { exec_info: { queue_remaining } });
    },

    queuePrompt: basePost,

    reset() {
        this._listeners = {};
        this._nextPromptId = 1;
        this.mode = "ok";
        this.accepted = [];
        this.queuePrompt = basePost;          // drop any wrapper a previous test installed
        delete this.__sain3RunOnceSubmitHook;
    },
};
