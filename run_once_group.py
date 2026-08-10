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
["...", "A-2. ④ 프롬프트 · LLM", "Bypass"] reloads as a one-line list and keeps working.
"""


class RunOnceGroupMode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enabled": ("BOOLEAN", {
                    "default": True,
                    "label_on": "적용",
                    "label_off": "끔",
                    "tooltip": "끄면 이 노드는 아무 것도 하지 않습니다.",
                }),
                "group_titles": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "대상 그룹 제목을 한 줄에 하나씩. 노드를 우클릭하면 현재 그래프의 "
                               "그룹을 체크해서 고를 수 있습니다. 구분자는 줄바꿈뿐입니다 — "
                               "그룹 제목 자체에 쉼표가 들어갈 수 있어서 쉼표는 쓰지 않습니다.",
                }),
                "mode_during_run": (["Bypass", "Mute", "Active"], {
                    "default": "Bypass",
                    "tooltip": "Run 을 누른 그 실행 동안 선택한 모든 그룹을 이 모드로 둡니다. "
                               "실행이 끝나면 각 노드의 원래 모드로 되돌립니다.",
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "utils"
    DESCRIPTION = ("Run 을 누를 때만 지정한 그룹들의 모드를 바꾸고, 실행이 끝나면 원래대로 "
                   "되돌립니다. 그룹은 여러 개 고를 수 있습니다. 실제 동작은 프론트엔드에서 "
                   "일어납니다.")

    def noop(self):
        return ()


# The class name is the workflow's key — renaming it would orphan every saved node.
# Only the display name changes.
NODE_CLASS_MAPPINGS = {"RunOnceGroupMode": RunOnceGroupMode}
NODE_DISPLAY_NAME_MAPPINGS = {"RunOnceGroupMode": "Run Once Group Toggle"}
