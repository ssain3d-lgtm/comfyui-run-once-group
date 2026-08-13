"""Schema tests for the Python half.  Run with: python tests/test_node.py

The backend node holds no behaviour, so there is nothing here about running it. What it does hold
is the contract every saved workflow is keyed to -- the class name and the widget order -- and
breaking either orphans nodes silently rather than raising anything. That is what this pins.
"""

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("run_once_group", ROOT / "run_once_group.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

results = []


def test(name):
    def wrap(fn):
        try:
            fn()
            results.append((True, name))
        except Exception as error:  # noqa: BLE001 - a failed assert is the reportable outcome
            results.append((False, f"{name}\n      {error!r}"))
    return wrap


NODE = module.NODE_CLASS_MAPPINGS["RunOnceGroupMode"]
REQUIRED = NODE.INPUT_TYPES()["required"]


@test("the class name every saved workflow stores is unchanged")
def _():
    assert list(module.NODE_CLASS_MAPPINGS) == ["RunOnceGroupMode"]
    assert module.NODE_DISPLAY_NAME_MAPPINGS["RunOnceGroupMode"] == "Run Once Group Toggle"


@test("widget order is unchanged, so widgets_values still restores positionally")
def _():
    assert list(REQUIRED) == ["enabled", "group_titles", "mode_during_run"], (
        "slot order is load-bearing: ComfyUI restores widgets_values by position"
    )


@test("group_titles is a multiline string in slot 1, where group_title used to be")
def _():
    kind, opts = REQUIRED["group_titles"]
    assert kind == "STRING"
    assert opts["multiline"] is True
    assert opts["default"] == ""


@test("enabled is a boolean defaulting to on")
def _():
    kind, opts = REQUIRED["enabled"]
    assert kind == "BOOLEAN"
    assert opts["default"] is True


@test("mode_during_run offers exactly the three litegraph modes the JS maps")
def _():
    choices, opts = REQUIRED["mode_during_run"]
    assert choices == ["Bypass", "Mute", "Active"]
    assert opts["default"] == "Bypass"


@test("the node can never be scheduled for execution")
def _():
    assert NODE.RETURN_TYPES == ()
    assert not getattr(NODE, "OUTPUT_NODE", False), (
        "an OUTPUT_NODE would be walked backwards from and executed"
    )
    assert callable(getattr(NODE, NODE.FUNCTION))


@test("every widget carries a tooltip")
def _():
    for name, (_kind, opts) in REQUIRED.items():
        assert opts.get("tooltip"), f"{name} has no tooltip"


@test("the package exports what ComfyUI loads")
def _():
    source = (ROOT / "__init__.py").read_text(encoding="utf-8")
    for expected in ("NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"):
        assert expected in source, f"__init__.py does not export {expected}"
    assert './web/js' in source or '"./web/js"' in source


failed = [r for ok, r in results if not ok]
for ok, name in results:
    print(f"{'  ok  ' if ok else '  FAIL'}  {name}")
print(f"\n{len(results) - len(failed)} pass / {len(failed)} fail")
sys.exit(1 if failed else 0)
