"""run_js / js.eval reachability. ``pyodide.code.run_js`` does ``from js import eval`` and then calls
it, so it is a wrapper for JS ``eval``. The shim hands Python a frozen, curated ``js`` with 15 names,
none of them ``eval`` (M0.33 shim-facts), so run_js dies with ImportError before any string reaches
V8 -- ``eval`` is simply not reachable from a plugin. This is a second layer, distinct from the
code-generation flag: the ``--disallow-code-generation-from-strings`` boundary itself is exercised by
the ``codegen`` attack through the reachable Function constructor. A successful eval here is an
escape."""

from pyodide.code import run_js

from ._util import denied, escaped


def run(host, args):
    try:
        value = run_js("globalThis.__dy_run_js_escape = 1; 40 + 2")
    except Exception as error:  # noqa: BLE001 - ImportError (js.eval is not exposed) is the denial
        return denied(type(error).__name__, error)
    return escaped("evaluated", f"value={value}")
