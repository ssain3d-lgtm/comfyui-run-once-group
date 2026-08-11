"""Config holder for the Run-Once group toggle. All behaviour lives in web/js.

Bypass is a litegraph concept: the frontend resolves mode 4 away inside graphToPrompt() and the
backend never learns the node existed. A backend node therefore cannot change the bypass state of
the run it belongs to -- by the time Python executes, the decision is long made. So this class does
nothing except give the JS a place to read settings from, and give the user something to see and
save with the workflow.

It declares no outputs and is not an OUTPUT_NODE, so ComfyUI's executor -- which walks backwards
from output nodes -- never schedules it. It costs one entry in the prompt dict and no execution.

Widget order is load-bearing. ComfyUI restores `widgets_values` positionally, so `group_titles`
must stay in slot 1 where the old single-line `group_title` was: a workflow saved with
["...", "D. Upscale - Interpolate", "Bypass"] reloads as a one-line list and keeps working.
"""


class RunOnceGroupMode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enabled": ("BOOLEAN", {
                    "default": True,
                    "label_on": "On",
                    "label_off": "Off",
                    "tooltip": "Turn this off and the node does nothing at all.",
                }),
                "group_titles": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "One target group title per line. Right-click the node to tick "
                               "groups from the current graph instead of typing them. Newline is "
                               "the only separator - titles often contain commas, so a comma "
                               "split would tear them in half and match nothing.",
                }),
                "mode_during_run": (["Bypass", "Mute", "Active"], {
                    "default": "Bypass",
                    "tooltip": "Hold every chosen group in this mode for the run you just "
                               "started, then put each node back to the mode it actually had.",
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "utils"
    DESCRIPTION = ("Switch the mode of the groups you choose for one queue submit, then restore "
                   "them when the run ends. Several groups at once. The work happens in the "
                   "frontend.")

    def noop(self):
        return ()


# The class name is the workflow's key — renaming it would orphan every saved node.
# Only the display name changes.
NODE_CLASS_MAPPINGS = {"RunOnceGroupMode": RunOnceGroupMode}
NODE_DISPLAY_NAME_MAPPINGS = {"RunOnceGroupMode": "Run Once Group Toggle"}
